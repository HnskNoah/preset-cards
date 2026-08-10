// profile-editor 弹窗：pcmanager 式左右两栏的 prompt 级编辑界面。
// 弹窗内全部改动走会话缓冲（sessionEdits / pendingToggles），Commit 才统一落盘。
// 不触发 #update_oai_preset（R2），保存后由调用方 refreshActivePresetUI。

import { renderExtensionTemplateAsync } from '@sillytavern/scripts/extensions';
import { oai_settings, openai_settings } from '@sillytavern/scripts/openai';
import { POPUP_TYPE, callGenericPopup, Popup } from '@sillytavern/scripts/popup';
import { EXTENSION_NAME } from './constants.js';
import { L } from './i18n.js';
import {
    getProfile,
    isPromptBaseProfile,
    isPromptDeltaProfile,
    readMeta,
    saveMeta,
    type Preset,
    type PresetMeta,
    type PromptBaseProfile,
    type PromptDeltaChange,
    type PromptDeltaProfile,
    type PromptProfileEntry,
} from './meta.js';
import {
    PROMPT_FIELD_WHITELIST,
    buildPromptSnapshot,
    capturePromptFields,
    filterFields,
    findPromptInPreset,
    applyResolvedPromptState,
    promptFieldsEqual,
    resolveParentStates,
    resolveProfilePrompts,
    snapshotToDelta,
} from './promptToggle.js';
import {
    applyBufferedEdits,
    bufferKey,
    bufferPrefix,
    clearBufferedForName,
    editedIdentifiersForName,
    type PromptEditBuffer,
} from './presetBuffers.js';
import { mergeBaseSnapshot, recordDefaultOriginalFields } from './presetSnapshot.js';
import { buildDerivedProfile } from './profileActions.js';
import { chooseProfileSaveTarget } from './importExport.js';
import { buildProfileEntries, buildProfileOrderCtx, type ProfileEntryView } from './presetList.js';
import { buildPromptEditForm } from './editModal.js';
import { arrangePromptEntries, mountedOrder } from './promptState.js';

/** 弹窗依赖：缓冲 Map 与刷新回调由 presetCards 闭包注入。 */
export interface ProfileEditorDeps {
    sessionEdits: Map<string, PromptEditBuffer>;
    pendingToggles: Map<string, boolean>;
    refreshActivePresetUI: (presetName: string) => void;
    /** 保存后刷新卡片网格。 */
    onGridRefresh: () => Promise<void>;
}

/** 统一应用本会话的开关/值编辑缓冲并采集快照：缺失条目提示跳过。 */
export function applyBufferedAndSnapshot(
    preset: Preset,
    name: string,
    sessionEdits: Map<string, PromptEditBuffer>,
    pendingToggles: Map<string, boolean>,
    pendingClears: Map<string, true>,
): PromptProfileEntry[] {
    const missing = applyBufferedEdits(preset, name, sessionEdits, pendingToggles);
    if (missing.length > 0) {
        toastr.warning(`${L('Missing prompts skipped')}: ${missing.join(', ')}`);
    }
    const include = editedIdentifiersForName(name, sessionEdits);
    const prefix = bufferPrefix(name);
    for (const key of pendingClears.keys()) {
        if (key.startsWith(prefix)) include.add(key.slice(prefix.length));
    }
    const snapshot = buildPromptSnapshot(preset, { includeFields: include });
    for (const entry of snapshot) {
        const key = bufferKey(name, entry.identifier);
        // R1：clear 的条目显式空 fields——delta 走 snapshotToChanges（空 fields 不产生差异、旧差异消失），
        // base 走 mergeBaseSnapshot（保留 prior fields）后由 applyPendingClearsToProfile 补删。
        // F2 防御：clear 后该条目已有新 session（重新编辑）则保留新值，不强置空 fields。
        if (pendingClears.has(key) && !sessionEdits.has(key)) {
            entry.fields = {};
        }
    }
    return snapshot;
}

// R1：把「清除值变更」应用到 profile 快照：删除对应条目的 fields。
// base 用 prompts[].fields（mergeBaseSnapshot 会保留 prior fields，须在此删除）；
// delta 已由 snapshotToChanges 重建 changes 覆盖，此处兜底删除自身 changes 的残留 fields。
function applyPendingClearsToProfile(
    profile: PromptBaseProfile | PromptDeltaProfile,
    pendingClears: Map<string, true>,
    name: string,
): void {
    const prefix = bufferPrefix(name);
    const ids = new Set<string>();
    for (const key of pendingClears.keys()) {
        if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
    }
    if (ids.size === 0) return;
    if (isPromptBaseProfile(profile)) {
        for (const p of profile.prompts) {
            if (ids.has(p.identifier)) delete p.fields;
        }
    } else {
        for (const c of profile.changes) {
            if (ids.has(c.identifier)) delete c.fields;
        }
    }
}

/** 「保存→更新」与「覆盖」共用的 base/delta 提交：按类型合并缓冲后的快照 → 持久化 → 成功提示。
 * missingParent 为 delta 父链缺失时的分歧路径：
 *   'full-changes'（保存→更新）：全量写成差异（含值字段）继续提交；
 *   'abort'（覆盖）：toast 提示并返回 false，调用方中止后续。
 * 仅处理 base/delta；成功时返回 true。 */
export async function commitBufferedEditsToProfile(
    profile: PromptBaseProfile | PromptDeltaProfile,
    snapshot: PromptProfileEntry[],
    meta: PresetMeta,
    name: string,
    idx: number,
    sessionEdits: Map<string, PromptEditBuffer>,
    missingParent: 'full-changes' | 'abort',
): Promise<boolean> {
    if (isPromptBaseProfile(profile)) {
        // enabled 合并当前目标 order 中的条目；fields 仅对本次编辑的条目（与编辑初值无净变化时清除），
        // 其余条目保留既有 fields（见 mergeBaseSnapshot）
        mergeBaseSnapshot(profile, snapshot, name, sessionEdits);
        recordDefaultOriginalFields(meta, name, sessionEdits);
    } else {
        // 基线用父链解析状态（不含本 delta 自身 changes），否则未编辑的已存差异与基线相等而被 diff 掉
        const parentEntries = resolveParentStates(profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]);
        if (parentEntries.length > 0) {
            const delta = snapshotToDelta(snapshot, parentEntries);
            profile.changes = delta.changes;
            if (delta.order) profile.order = delta.order;
            else delete profile.order;
        } else if (missingParent === 'full-changes') {
            // 父链缺失：全量写成差异（含值字段）；空 fields（clear 条目）不写入（F3）
            profile.changes = snapshot.map((s) => {
                const change: PromptDeltaChange = {
                    identifier: s.identifier,
                    mounted: s.mounted,
                    enabled: s.enabled,
                    lastActiveIndex: s.lastActiveIndex,
                };
                if (s.fields && Object.keys(s.fields).length > 0) change.fields = s.fields;
                return change;
            });
        } else {
            toastr.warning(L('Base profile not found, cannot update derived configuration'));
            return false;
        }
        recordDefaultOriginalFields(meta, name, sessionEdits);
    }

    await saveMeta(name, idx, meta);
    toastr.success(L('Configuration updated'));
    return true;
}

/** 右栏 staged diff 的一条记录。 */
interface StagedFieldChange {
    label: string;
    from: string;
    to: string;
}

interface StagedItem {
    identifier: string;
    key: string;
    label: string;
    toggle?: { original: boolean; target: boolean };
    membership?: { original: boolean; target: boolean };
    order?: boolean;
    fields: StagedFieldChange[];
    /** R1：本条目存在「清除值变更」待提交（commit 时删除 profile 快照 fields）。 */
    clear?: boolean;
}

function fmtValue(v: unknown): string {
    return v === undefined || v === null ? '' : String(v);
}

function cssEscape(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 面包屑的一项：节点名 + 是否当前节点（末项）+ 是否截断占位（…）。 */
export interface BreadcrumbItem {
    name: string;
    isCurrent: boolean;
    /** 截断占位项（…），不渲染独立 title。 */
    isEllipsis?: boolean;
}

// 沿 baseId 链向上收集节点名，构建派生链面包屑（root → 当前）。
// 截断规则：链 ≤3 全显示；3 < 链 ≤5 显示 `… ▸ 父 ▸ 当前`；链 >5 只显示当前。
// 防环：visited 记录已访问 id，成环数据不致死循环。
export function buildBreadcrumb(profile: PromptBaseProfile | PromptDeltaProfile, meta: PresetMeta): { items: BreadcrumbItem[]; title: string } {
    const chain: { name: string; id: string }[] = [];
    const visited = new Set<string>();
    let current: { name: string; id: string } = { name: profile.name, id: String(profile.id) };
    while (!visited.has(current.id)) {
        visited.add(current.id);
        chain.unshift(current);
        if (chain.length > 50) break; // 硬上限，防御极端损坏数据
        // 当前节点若是 delta，沿 baseId 向上找父；base/v1 或父缺失/非 base/delta 即到根
        const node = getProfile(meta, current.id);
        if (!node || !isPromptDeltaProfile(node)) break;
        const parent = getProfile(meta, node.baseId);
        if (!parent || (!isPromptBaseProfile(parent) && !isPromptDeltaProfile(parent))) break;
        current = { name: parent.name, id: String(parent.id) };
    }

    const title = chain.map((item) => item.name).join(' ▸ ');
    let items: BreadcrumbItem[];
    if (chain.length <= 3) {
        items = chain.map((item, i) => ({ name: item.name, isCurrent: i === chain.length - 1 }));
    } else if (chain.length <= 5) {
        const tail = chain.slice(-2);
        items = [
            { name: '…', isCurrent: false, isEllipsis: true },
            ...tail.map((item, i) => ({ name: item.name, isCurrent: i === tail.length - 1 })),
        ];
    } else {
        const last = chain[chain.length - 1];
        items = [{ name: last.name, isCurrent: true }];
    }
    return { items, title };
}

export async function openProfileEditorPopup(
    deps: ProfileEditorDeps,
    name: string,
    idx: number,
    profileId: string,
): Promise<void> {
    const { sessionEdits, pendingToggles } = deps;
    const prefix = bufferPrefix(name);

    let dialog: JQuery<HTMLElement> = $('<div id="preset_profile_editor" class="pc-manager-container"></div>');
    let searchQuery = '';
    /** 搜索索引缓存：identifier → 名称/content 小写，渲染时构建、改名时增量更新，避免每次按键全量转小写并读 DOM。 */
    let searchIndex = new Map<string, { name: string; content: string }>();
    let editTargetId: string | null = null;
    let mobileShowRight = false;
    /** 本会话拖拽重排过的条目。 */
    const reorderedIds = new Set<string>();
    const pendingMembership = new Map<string, boolean>();
    const pendingLastActiveIndex = new Map<string, number>();
    /** R1：本会话「清除值变更」缓冲（key = bufferKey(name, identifier)）；Commit 才删除 profile 快照 fields。 */
    const pendingClears = new Map<string, true>();
    let baselineStates: PromptProfileEntry[] = [];
    let initialMountedOrder: string[] = [];
    let stagedOrder: string[] = [];
    let popup: Popup;

    const reloadBaseline = (): boolean => {
        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile || (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile))) return false;
        const supported = meta.profiles.filter(
            (candidate): candidate is PromptBaseProfile | PromptDeltaProfile => isPromptBaseProfile(candidate) || isPromptDeltaProfile(candidate),
        );
        baselineStates = resolveProfilePrompts(profile, supported, new Set());
        const known = new Set(baselineStates.map((entry) => entry.identifier));
        for (const prompt of Array.isArray(preset.prompts) ? preset.prompts : []) {
            if (!prompt || typeof prompt.identifier !== 'string' || !prompt.identifier || known.has(prompt.identifier)) continue;
            baselineStates.push({ identifier: prompt.identifier, mounted: false, enabled: false });
            known.add(prompt.identifier);
        }
        initialMountedOrder = mountedOrder(baselineStates);
        stagedOrder = [...initialMountedOrder];
        return true;
    };
    if (!reloadBaseline()) return;

    // 读取当前预设/元数据/profile 解析后的展示条目（每次调用取最新内存态，clear 等直接改内存对象）
    const currentCtx = (): { preset: Preset; meta: PresetMeta; profile: PromptBaseProfile | PromptDeltaProfile; entries: ProfileEntryView[]; states: PromptProfileEntry[] } | undefined => {
        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile || (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile))) return undefined;
        const states = baselineStates.map((entry) => ({ ...entry, fields: entry.fields ? { ...entry.fields } : undefined }));
        for (const entry of states) {
            const membership = pendingMembership.get(entry.identifier);
            if (membership !== undefined) {
                if (!membership && entry.mounted) {
                    const index = pendingLastActiveIndex.get(entry.identifier) ?? stagedOrder.indexOf(entry.identifier);
                    if (index >= 0) entry.lastActiveIndex = index;
                }
                entry.mounted = membership;
            }
            const toggle = pendingToggles.get(bufferKey(name, entry.identifier));
            if (toggle !== undefined) entry.enabled = toggle;
        }
        const arranged = arrangePromptEntries(states, stagedOrder);
        const viewProfile: PromptBaseProfile = {
            formatVersion: 3,
            kind: 'prompt_base',
            id: '__editor__',
            name: profile.name,
            prompts: arranged,
        };
        const viewMeta: PresetMeta = { ...meta, profiles: [viewProfile] };
        return {
            preset,
            meta,
            profile,
            entries: buildProfileEntries(viewProfile, viewMeta, preset, buildProfileOrderCtx(
                preset,
                oai_settings.preset_settings_openai === name,
            )),
            states: arranged,
        };
    };

    // 搜索索引：一次构建（entries 来自内存解析，content 可能较长），applySearch 只读缓存。
    function rebuildSearchIndex(): void {
        const ctx = currentCtx();
        searchIndex = new Map((ctx?.entries ?? []).map((e) => [
            e.identifier,
            { name: (e.name ?? '').toLowerCase(), content: (e.content ?? '').toLowerCase() },
        ]));
    }

    type EditorCtx = NonNullable<ReturnType<typeof currentCtx>>;

    const FIELD_LABELS: Record<string, string> = {
        content: L('Content'),
        name: L('Name'),
        role: L('Role'),
        injection_position: L('Position'),
        injection_depth: L('Injection Depth'),
    };

    // ---- Staged diff（当前未提交的缓冲改动：开关切换 / 值修改） ----
    // R9：接收外部已算好的 ctx，避免同一事件 tick 内多次全量 profile 解析（缺省时自行取最新）
    function stagedItems(ctx?: EditorCtx): StagedItem[] {
        const resolvedCtx = ctx ?? currentCtx();
        if (!resolvedCtx) return [];
        const nameById = new Map(resolvedCtx.entries.map((e) => [e.identifier, e.name]));
        const enabledById = new Map(baselineStates.map((e) => [e.identifier, e.enabled]));
        const mountedById = new Map(baselineStates.map((e) => [e.identifier, e.mounted]));

        const keys = new Set<string>();
        for (const k of pendingToggles.keys()) if (k.startsWith(prefix)) keys.add(k);
        for (const k of sessionEdits.keys()) if (k.startsWith(prefix)) keys.add(k);
        for (const k of pendingClears.keys()) if (k.startsWith(prefix)) keys.add(k);
        for (const identifier of pendingMembership.keys()) keys.add(bufferKey(name, identifier));

        const items: StagedItem[] = [];
        for (const key of keys) {
            const identifier = key.slice(prefix.length);
            const item: StagedItem = { identifier, key, label: nameById.get(identifier) ?? identifier, fields: [] };
            const toggleTarget = pendingToggles.get(key);
            if (toggleTarget !== undefined) {
                item.toggle = { original: enabledById.get(identifier) ?? true, target: toggleTarget };
            }
            const membershipTarget = pendingMembership.get(identifier);
            if (membershipTarget !== undefined) {
                item.membership = { original: mountedById.get(identifier) ?? false, target: membershipTarget };
            }
            const session = sessionEdits.get(key);
            if (session) {
                for (const field of PROMPT_FIELD_WHITELIST) {
                    if (session.initial[field] !== session.edited[field]) {
                        item.fields.push({
                            label: FIELD_LABELS[field] ?? field,
                            from: fmtValue(session.initial[field]),
                            to: fmtValue(session.edited[field]),
                        });
                    }
                }
            }
            // F2：clear 后重新编辑（session 存在）视为清除被覆盖，不渲染 clear 项
            if (pendingClears.has(key) && !session) {
                item.clear = true;
            }
            items.push(item);
        }
        if (stagedOrder.length !== initialMountedOrder.length
            || stagedOrder.some((identifier, index) => identifier !== initialMountedOrder[index])) {
            items.unshift({ identifier: '__order__', key: '__order__', label: L('Order adjusted'), fields: [], order: true });
        }
        // 按 entries（prompt_order 展示顺序）排序，而非 identifier 字母序；未知 identifier 排最后
        const orderIdx = new Map(resolvedCtx.entries.map((e, i) => [e.identifier, i]));
        items.sort((a, b) => {
            const ia = orderIdx.get(a.identifier);
            const ib = orderIdx.get(b.identifier);
            return (ia ?? Number.MAX_SAFE_INTEGER) - (ib ?? Number.MAX_SAFE_INTEGER);
        });
        return items;
    }

    // ---- 渲染 ----
    async function renderDialog(): Promise<void> {
        const ctx = currentCtx();
        if (!ctx) return;
        const items = stagedItems(ctx);
        const { items: breadcrumb, title: breadcrumbTitle } = buildBreadcrumb(ctx.profile, ctx.meta);

        const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'profile-editor', {
            presetName: name,
            breadcrumb,
            breadcrumbTitle,
            activeEntries: ctx.entries.filter((entry) => entry.mounted),
            unusedEntries: ctx.entries.filter((entry) => !entry.mounted),
            stagedCount: items.length,
            canCommit: items.length > 0,
            i18n: {
                rename: L('Rename'),
                viewStaged: L('View Staged'),
                commit: L('Commit'),
                close: L('Close'),
                backToList: L('Back to list'),
                searchPrompts: L('Search prompts...'),
                dragHandle: L('Drag to reorder'),
                clearValueChange: L('Clear value changes'),
                toggleEntry: L('Toggle entry'),
                noEntries: L('No entries'),
                noSearchResults: L('No prompts found'),
                unusedPrompts: L('Unused Prompts'),
                unusedStatus: L('Not used for generation'),
                activatePrompt: L('Activate prompt'),
                deactivatePrompt: L('Move to unused'),
            },
        });

        const newDialog = $(html);
        // 模板根节点是 #preset_profile_editor：取其子节点填入 dialog，保持 dialog 元素身份稳定
        //（delegated 事件绑定不丢，id/样式仍作用于 dialog 本身）
        const children = newDialog.children().toArray();
        dialog.empty().append(children);

        rebuildSearchIndex();
        applyBufferOverlay();
        applySearch();
        // R4：commit 后 renderDialog 重建模板，输入框无 value——按闭包 searchQuery 回填，与过滤结果一致
        dialog.find('#pc-search-input').val(searchQuery);
        renderRightPane(ctx);
        setupSortable();
        refreshCounts(ctx);
    }

    // 把缓冲状态叠加到已渲染的条目列表（开关目标 / 编辑后的名字 / dirty 高亮）
    function applyBufferOverlay(): void {
        dialog.find('.pc-prompt-card').each(function () {
            const entry = $(this);
            const identifier = String(entry.data('identifier'));
            const key = bufferKey(name, identifier);
            const toggleTarget = pendingToggles.get(key);
            const session = sessionEdits.get(key);

            const toggle = entry.find('.pc-btn-toggle');
            if (toggle.length && toggleTarget !== undefined) {
                toggle.toggleClass('on', toggleTarget).toggleClass('off', !toggleTarget);
                toggle.html(toggleTarget
                    ? '<i class="fa-solid fa-toggle-on"></i> On'
                    : '<i class="fa-solid fa-toggle-off"></i> Off');
                entry.toggleClass('disabled', !toggleTarget);
            }
            if (session?.edited.name !== undefined) {
                entry.find('.pc-card-name').text(session.edited.name).attr('title', identifier);
                const idx = searchIndex.get(identifier);
                if (idx) idx.name = session.edited.name.toLowerCase();
            }
            if (sessionEdits.has(key) || pendingToggles.has(key) || pendingClears.has(key)
                || pendingMembership.has(identifier) || reorderedIds.has(identifier)) {
                entry.addClass('dirty');
            }
        });
    }

    function applySearch(): void {
        const q = searchQuery.toLowerCase().trim();
        let visible = 0;
        dialog.find('.pc-prompt-card').each(function () {
            const identifier = String($(this).data('identifier'));
            const idx = searchIndex.get(identifier);
            const match = !q || !!(idx && (idx.name.includes(q) || idx.content.includes(q) || identifier.toLowerCase().includes(q)));
            $(this).toggle(match);
            if (match) visible++;
        });
        dialog.find('#pc-prompt-empty-search').toggle(visible === 0 && q.length > 0);
        if (q) dialog.find('.pc-unused-section').prop('open', true);
    }

    function renderStagedPane(ctx?: EditorCtx): void {
        const diffArea = dialog.find('#pc-diff-area');
        diffArea.empty();
        const items = stagedItems(ctx);
        if (items.length === 0) {
            diffArea.append($('<div class="pc-diff-empty"></div>').text(L('No staged changes')));
            return;
        }
        diffArea.append($('<h3 class="pc-diff-title"></h3>').text(L('Staged Changes')));
        const list = $('<ul class="pc-diff-list"></ul>');
        for (const item of items) {
            if (item.order) {
                const undo = $('<button class="pc-btn-undo"></button>')
                    .append($('<i class="fa-solid fa-rotate-left"></i>'))
                    .append(' ' + L('Undo'))
                    .on('click', () => {
                        stagedOrder = [...initialMountedOrder];
                        reorderedIds.clear();
                        void renderDialog();
                    });
                list.append($('<li class="pc-diff-item diff-reorder"></li>')
                    .append($('<span class="pc-diff-desc"></span>').text(L('Order adjusted')))
                    .append(undo));
            }
            if (item.membership) {
                list.append($('<li class="pc-diff-item diff-membership"></li>')
                    .append($('<span class="pc-diff-desc"></span>').text(`${item.label}: ${L('Usage status')} ${item.membership.original ? L('Active') : L('Unused')} → ${item.membership.target ? L('Active') : L('Unused')}`))
                    .append(buildUndoBtn(item.key, item.identifier)));
            }
            if (item.toggle) {
                list.append($('<li class="pc-diff-item diff-toggle"></li>')
                    .append($('<span class="pc-diff-desc"></span>').text(`${L('Switch')}: ${item.toggle.original ? L('On') : L('Off')} → ${item.toggle.target ? L('On') : L('Off')}`))
                    .append(buildUndoBtn(item.key, item.identifier)));
            }
            for (const f of item.fields) {
                list.append($('<li class="pc-diff-item diff-modify"></li>')
                    .append($('<span class="pc-diff-desc"></span>').text(`${item.label}: ${f.from || '∅'} → ${f.to || '∅'}`))
                    .append(buildUndoBtn(item.key, item.identifier)));
            }
            if (item.clear) {
                list.append($('<li class="pc-diff-item diff-clear"></li>')
                    .append($('<span class="pc-diff-desc"></span>').text(`${item.label}: ${L('Clear value changes')}`))
                    .append(buildUndoBtn(item.key, item.identifier, true)));
            }
        }
        diffArea.append(list);
    }

    function buildUndoBtn(key: string, identifier: string, onlyClear = false): JQuery<HTMLElement> {
        const undo = $('<button class="pc-btn-undo"></button>')
            .append($('<i class="fa-solid fa-rotate-left"></i>'))
            .append(' ' + L('Undo'));
        undo.on('click', () => {
            // clear 项独立 undo（仅撤销 pendingClears；profile 快照 fields 未动，恢复即自然）；
            // toggle/值编辑项仍按原语义整体撤销
            if (onlyClear) {
                pendingClears.delete(key);
                refreshEntryRow(identifier);
                refreshCounts();
                renderRightPane();
            } else {
                undoStaged(key, identifier);
                void renderDialog();
            }
        });
        return undo;
    }

    // 右栏路由：有编辑目标 → 内联编辑表单；否则 staged diff。
    // 手机端（≤768px）默认右栏隐藏，mobileShowRight 时加 .pc-show-right 让右栏全宽覆盖列表。
    function renderRightPane(ctx?: EditorCtx): void {
        dialog.find('.pc-layout').toggleClass('pc-show-right', mobileShowRight);
        const diffArea = dialog.find('#pc-diff-area');
        const editArea = dialog.find('#pc-edit-area');
        if (editTargetId) {
            const resolvedCtx = ctx ?? currentCtx();
            const view = resolvedCtx?.entries.find((e) => e.identifier === editTargetId);
            if (resolvedCtx && view?.editable) {
                editArea.empty().append(buildInlineEdit(resolvedCtx.preset, editTargetId));
                editArea.show();
                diffArea.hide();
                return;
            }
            // 条目不可编辑（system_prompt / marker / 缺失）→ 回退 staged 视图
            editTargetId = null;
            mobileShowRight = false;
        }
        editArea.hide();
        diffArea.show();
        renderStagedPane(ctx);
    }

    // 内联编辑表单（PC 右栏 / 手机全宽覆盖）：复用 editModal 的表单构造，保存写会话缓冲
    function buildInlineEdit(preset: Preset, identifier: string): JQuery<HTMLElement> {
        const prompt = findPromptInPreset(preset, identifier);
        const wrap = $('<div class="pc-edit-form"></div>');
        if (!prompt) {
            wrap.append($('<div class="pc-diff-empty"></div>').text(L('No entries')));
            return wrap;
        }

        const header = $('<div class="pc-editor-header"></div>');
        header.append($('<h3></h3>').text(prompt.name ?? identifier));
        const actions = $('<div class="pc-editor-actions"></div>');
        const mounted = currentCtx()?.entries.find((entry) => entry.identifier === identifier)?.mounted ?? false;
        const membershipBtn = $('<button class="pc-btn-icon pc-btn-membership" title="' + (mounted ? L('Move to unused') : L('Activate prompt')) + '"></button>')
            .attr('data-identifier', identifier)
            .append($(`<i class="fa-solid ${mounted ? 'fa-link-slash' : 'fa-plus'}"></i>`));

        const prevSession = sessionEdits.get(bufferKey(name, identifier));
        const current = prevSession ? { ...capturePromptFields(prompt), ...prevSession.edited } : undefined;
        const form = buildPromptEditForm(preset, identifier, current);

        const saveBtn = $('<button class="pc-btn-icon pc-btn-icon-primary" title="' + L('Save') + '"></button>')
            .append($('<i class="fa-solid fa-save"></i>'))
            .append(' ' + L('Save'));
        const cancelBtn = $('<button class="pc-btn-icon" title="' + L('Cancel') + '"></button>')
            .append($('<i class="fa-solid fa-times"></i>'))
            .append(' ' + L('Cancel'));

        saveBtn.on('click', () => {
            const editedFields = form.collectFields();
            if (editedFields) {
                const key = bufferKey(name, identifier);
                // F2：clear 后重新编辑视为覆盖「清除」意图
                pendingClears.delete(key);
                const session = sessionEdits.get(key);
                const initial = session?.initial ?? capturePromptFields(prompt);
                const edited = { ...(session?.edited ?? {}), ...filterFields(editedFields) };
                if (promptFieldsEqual(edited, initial)) {
                    sessionEdits.delete(key);
                } else {
                    sessionEdits.set(key, { initial, edited });
                }
            }
            editTargetId = null;
            mobileShowRight = false;
            refreshEntryRow(identifier);
            refreshCounts();
            renderRightPane();
        });
        cancelBtn.on('click', () => {
            editTargetId = null;
            mobileShowRight = false;
            renderRightPane();
        });

        actions.append(membershipBtn).append(saveBtn).append(cancelBtn);
        header.append(actions);
        wrap.append(header);
        wrap.append(form.container);
        return wrap;
    }

    // 局部刷新单条 entry（名字/开关/dirty/clear 可见性）
    function refreshEntryRow(identifier: string, ctx?: EditorCtx): void {
        const row = dialog.find(`.pc-prompt-card[data-identifier="${cssEscape(identifier)}"]`);
        if (row.length === 0) return;
        const resolvedCtx = ctx ?? currentCtx();
        const view = resolvedCtx?.entries.find((e) => e.identifier === identifier);
        const key = bufferKey(name, identifier);
        const toggleTarget = pendingToggles.get(key);
        const session = sessionEdits.get(key);
        const enabled = toggleTarget ?? view?.enabled ?? true;
        const displayName = session?.edited.name ?? view?.name ?? identifier;

        row.find('.pc-card-name').text(displayName).attr('title', identifier);
        const idx = searchIndex.get(identifier);
        if (idx) idx.name = displayName.toLowerCase();

        const toggle = row.find('.pc-btn-toggle');
        if (toggle.length) {
            toggle.toggleClass('on', enabled).toggleClass('off', !enabled);
            toggle.html(enabled ? '<i class="fa-solid fa-toggle-on"></i> On' : '<i class="fa-solid fa-toggle-off"></i> Off');
        }

        const clearBtn = row.find('.pc-card-clear');
        const shouldHaveClear = !!view?.clearable;
        if (shouldHaveClear && clearBtn.length === 0) {
            const btn = $('<button class="pc-card-clear" title="' + L('Clear value changes') + '"><i class="fa-solid fa-eraser"></i></button>');
            const toggleEl = row.find('.pc-btn-toggle');
            if (toggleEl.length) btn.insertBefore(toggleEl);
            else row.append(btn);
        } else if (!shouldHaveClear) {
            clearBtn.remove();
        }

        row.toggleClass('disabled', !enabled);
        row.toggleClass('dirty', sessionEdits.has(key) || pendingToggles.has(key) || pendingClears.has(key)
            || pendingMembership.has(identifier) || reorderedIds.has(identifier));
        row.toggleClass('persistent', !!view?.hasPersistentDiff);
    }

    function recomputeReorderedIds(): void {
        reorderedIds.clear();
        const initialIndex = new Map(initialMountedOrder.map((entry, index) => [entry, index]));
        stagedOrder.forEach((identifier, index) => {
            if (initialIndex.get(identifier) !== index) reorderedIds.add(identifier);
        });
    }

    // Undo 某条缓冲：只恢复该条 membership，其余 staged order 与拖拽改动保持不变。
    function undoStaged(key: string, identifier: string): void {
        pendingToggles.delete(key);
        pendingMembership.delete(identifier);
        pendingLastActiveIndex.delete(identifier);

        const baseline = baselineStates.find((entry) => entry.identifier === identifier);
        if (baseline) {
            stagedOrder = stagedOrder.filter((id) => id !== identifier);
            if (baseline.mounted) {
                const historicalIndex = baseline.lastActiveIndex
                    ?? initialMountedOrder.indexOf(identifier);
                const insertIndex = historicalIndex >= 0
                    ? Math.min(historicalIndex, stagedOrder.length)
                    : stagedOrder.length;
                stagedOrder.splice(insertIndex, 0, identifier);
            }
        }
        recomputeReorderedIds();

        const session = sessionEdits.get(key);
        if (session) {
            sessionEdits.delete(key);
            const preset = openai_settings[idx] as Preset;
            const prompt = findPromptInPreset(preset, identifier);
            if (prompt) {
                for (const f of PROMPT_FIELD_WHITELIST) {
                    if (!(f in session.initial)) delete prompt[f];
                }
                Object.assign(prompt, session.initial);
            }
            if (oai_settings.preset_settings_openai === name) {
                const livePrompts = Array.isArray(oai_settings.prompts) ? oai_settings.prompts : [];
                const livePrompt = livePrompts.find((p: any) => p && p.identifier === identifier);
                if (livePrompt) {
                    for (const f of PROMPT_FIELD_WHITELIST) {
                        if (!(f in session.initial)) delete livePrompt[f];
                    }
                    Object.assign(livePrompt, filterFields(session.initial));
                }
            }
        }
    }

    // 拖拽排序只更新 staged active order；搜索中禁用。
    function setupSortable(): void {
        const listEl = dialog.find('.pc-active-prompt-list');
        if (!listEl.length) return;
        const shouldSortable = !searchQuery && oai_settings.preset_settings_openai === name;
        const isSortable = !!listEl.data('ui-sortable');
        // 幂等切换：避免每次按键 destroy/重建（搜索中本就禁用拖拽）
        if (isSortable && !shouldSortable) listEl.sortable('destroy');
        if (shouldSortable && !isSortable) {
            listEl.sortable({
                axis: 'y',
                handle: '.pc-drag-handle',
                items: '.pc-prompt-card',
                placeholder: 'pc-sortable-placeholder',
                start: () => listEl.addClass('sorting'),
                stop: () => listEl.removeClass('sorting'),
                update: () => { onReorder(listEl); },
            });
        }
    }

    function onReorder(listEl: JQuery<HTMLElement>): void {
        const domIds = listEl.find('.pc-prompt-card').map(function () {
            return String($(this).data('identifier'));
        }).get();
        stagedOrder = domIds;
        reorderedIds.clear();
        const initialIndex = new Map(initialMountedOrder.map((identifier, index) => [identifier, index]));
        stagedOrder.forEach((identifier, index) => {
            if (initialIndex.get(identifier) !== index) reorderedIds.add(identifier);
        });
        listEl.find('.pc-prompt-card').each(function (index) {
            const identifier = String($(this).data('identifier'));
            $(this).find('.pc-card-index span').text(String(index + 1).padStart(2, '0'));
            $(this).toggleClass('dirty', reorderedIds.has(identifier)
                || sessionEdits.has(bufferKey(name, identifier))
                || pendingToggles.has(bufferKey(name, identifier))
                || pendingClears.has(bufferKey(name, identifier))
                || pendingMembership.has(identifier));
        });
        refreshCounts();
        renderRightPane();
    }

    function refreshCounts(ctx?: EditorCtx): void {
        const n = stagedItems(ctx).length;
        dialog.find('#pc-btn-view-staged span').text(`(${n})`);
        const commitBtn = dialog.find('#pc-btn-commit');
        commitBtn.prop('disabled', n === 0);
        commitBtn.toggleClass('disabled', n === 0);
    }

    // 清空当前 name 的全部会话缓冲（含 pendingClears）：commit 消费后与关闭丢弃时共用
    const clearBuffers = (): void => {
        clearBufferedForName(name, sessionEdits, pendingToggles);
        pendingClears.clear();
        pendingMembership.clear();
        pendingLastActiveIndex.clear();
    };

    async function toggleMembership(identifier: string): Promise<void> {
        const ctx = currentCtx();
        const view = ctx?.entries.find((entry) => entry.identifier === identifier);
        const baseline = baselineStates.find((entry) => entry.identifier === identifier);
        if (!view || !baseline || !view.membershipEditable) return;
        if (!view.editable) {
            const confirmed = await callGenericPopup(
                L('Changing whether a system or marker prompt is used can affect prompt structure. Continue?'),
                POPUP_TYPE.CONFIRM,
            );
            if (!confirmed) return;
        }
        const target = !view.mounted;
        const capturedHistoricalIndex = pendingLastActiveIndex.get(identifier);
        if (target === baseline.mounted) pendingMembership.delete(identifier);
        else pendingMembership.set(identifier, target);

        if (!target) {
            const currentIndex = stagedOrder.indexOf(identifier);
            if (target !== baseline.mounted && currentIndex >= 0) pendingLastActiveIndex.set(identifier, currentIndex);
            else pendingLastActiveIndex.delete(identifier);
        } else {
            pendingLastActiveIndex.delete(identifier);
        }
        stagedOrder = stagedOrder.filter((id) => id !== identifier);
        if (target) {
            const historicalIndex = capturedHistoricalIndex ?? baseline.lastActiveIndex;
            if (historicalIndex !== undefined && historicalIndex >= 0 && historicalIndex <= stagedOrder.length) {
                stagedOrder.splice(historicalIndex, 0, identifier);
            } else {
                stagedOrder.push(identifier);
            }
        }
        await renderDialog();
    }

    // ---- 事件（delegated，重渲染 innerHTML 后仍然有效） ----
    dialog.on('click', '.pc-prompt-card', function (e) {
        if ($(e.target).closest('.pc-drag-handle, .pc-card-clear, .pc-btn-toggle, button').length) return;
        const identifier = String($(this).data('identifier'));
        const ctx = currentCtx();
        const view = ctx?.entries.find((x) => x.identifier === identifier);
        if (!view?.editable) return; // system_prompt / marker 不渲染编辑
        editTargetId = identifier;
        mobileShowRight = true;
        renderRightPane();
    });

    dialog.on('click', '.pc-btn-membership', function (e) {
        e.stopPropagation();
        const identifier = String($(this).attr('data-identifier') ?? $(this).closest('.pc-prompt-card').data('identifier'));
        void toggleMembership(identifier);
    });

    dialog.on('click', '.pc-btn-toggle', function (e) {
        e.stopPropagation();
        const toggle = $(this);
        const entry = toggle.closest('.pc-prompt-card');
        const identifier = String(entry.data('identifier'));
        const key = bufferKey(name, identifier);
        const on = toggle.hasClass('on');
        const target = !on;

        // 净零参照 = 目标 profile 解析链下的 enabled：目标等于解析值 → 删缓冲，否则记录
        const ctx = currentCtx();
        let resolvedEnabled: boolean | undefined;
        if (ctx) {
            resolvedEnabled = baselineStates.find((entry) => entry.identifier === identifier)?.enabled;
        }
        if (resolvedEnabled === target) {
            pendingToggles.delete(key);
        } else {
            pendingToggles.set(key, target);
        }

        // R9：同一 tick 只解析一次 profile（刷新函数复用 ctx）
        refreshEntryRow(identifier, ctx);
        refreshCounts(ctx);
        renderRightPane(ctx);
    });

    dialog.on('click', '.pc-card-clear', function (e) {
        e.stopPropagation();
        const entry = $(this).closest('.pc-prompt-card');
        const identifier = String(entry.data('identifier'));
        const key = bufferKey(name, identifier);
        const ctx = currentCtx();
        if (!ctx) return;
        const preset = openai_settings[idx] as Preset;

        // R1：不再直接改 profile 内存快照（否则会被拖拽 saveMeta 静默落盘、且无法进入 staged diff）；
        // clear 记入 pendingClears 缓冲，Commit 时统一删除快照 fields
        // 撤销会话值缓冲（full undo）：还原运行时至会话初始值并镜像活动预设
        const session = sessionEdits.get(key);
        if (session) {
            sessionEdits.delete(key);
            const prompt = findPromptInPreset(preset, identifier);
            if (prompt) {
                for (const f of PROMPT_FIELD_WHITELIST) {
                    if (!(f in session.initial)) delete prompt[f];
                }
                Object.assign(prompt, session.initial);
            }
            if (oai_settings.preset_settings_openai === name) {
                const livePrompts = Array.isArray(oai_settings.prompts) ? oai_settings.prompts : [];
                const livePrompt = livePrompts.find((p: any) => p && p.identifier === identifier);
                if (livePrompt) {
                    for (const f of PROMPT_FIELD_WHITELIST) {
                        if (!(f in session.initial)) delete livePrompt[f];
                    }
                    Object.assign(livePrompt, filterFields(session.initial));
                }
            }
        }

        pendingClears.set(key, true);

        // F8：复用已取出的 ctx，避免重复全量解析
        renderRightPane(ctx);
        refreshEntryRow(identifier, ctx);
        refreshCounts(ctx);
    });

    dialog.on('click', '#pc-btn-view-staged', function () {
        editTargetId = null;
        mobileShowRight = true;
        renderRightPane();
    });

    // 重命名当前 profile：面包屑末项（当前节点）变行内 input，Enter/blur 提交 → saveMeta + 刷新。
    dialog.on('click', '#pc-btn-rename', function () {
        const ctx = currentCtx();
        if (!ctx) return;

        const currentItem = dialog.find('.pc-breadcrumb-item.pc-breadcrumb-current');
        if (currentItem.length === 0) return;

        const currentName = ctx.profile.name;
        const input = $('<input>', {
            type: 'text',
            class: 'pc-header-rename-input',
            value: currentName,
        });
        currentItem.replaceWith(input);
        input.focus();

        let done = false;
        input.on('blur keydown', async function (evt) {
            const key = (evt.originalEvent as KeyboardEvent | undefined)?.key ?? '';
            if (evt.type === 'keydown' && key !== 'Enter' && key !== 'Escape') return;
            evt.stopPropagation();
            if (done) return;
            done = true;

            const newName = key === 'Escape' ? currentName : (input.val() as string).trim() || currentName;

            if (newName !== currentName && key !== 'Escape') {
                ctx.profile.name = newName;
                await saveMeta(name, idx, ctx.meta);
                toastr.success(`${L('Rename')}: ${newName}`);
                // 刷新标题/面包屑/卡片
                await renderDialog();
                await deps.onGridRefresh();
            } else {
                await renderDialog();
            }
        });
    });

    // 手机端「返回列表」
    dialog.on('click', '#pc-btn-mobile-back', function () {
        editTargetId = null;
        mobileShowRight = false;
        renderRightPane();
    });

    function buildCommitSnapshot(ctx: EditorCtx): PromptProfileEntry[] {
        const snapshot = ctx.states.map((entry) => ({ ...entry, fields: entry.fields ? { ...entry.fields } : undefined }));
        const parentStates = isPromptDeltaProfile(ctx.profile)
            ? resolveParentStates(ctx.profile, ctx.meta.profiles.filter(
                (candidate): candidate is PromptBaseProfile | PromptDeltaProfile => isPromptBaseProfile(candidate) || isPromptDeltaProfile(candidate),
            ))
            : [];
        const parentById = new Map(parentStates.map((entry) => [entry.identifier, entry]));
        for (const entry of snapshot) {
            const key = bufferKey(name, entry.identifier);
            const session = sessionEdits.get(key);
            if (session) entry.fields = filterFields(session.edited);
            if (pendingClears.has(key) && !session) {
                const parent = parentById.get(entry.identifier);
                if (parent?.fields) entry.fields = { ...parent.fields };
                else delete entry.fields;
            }
        }
        return snapshot;
    }

    dialog.on('click', '#pc-btn-commit', async function () {
        const ctx = currentCtx();
        if (!ctx) return;
        if (stagedItems().length === 0) return;
        if (!isPromptBaseProfile(ctx.profile) && !isPromptDeltaProfile(ctx.profile)) {
            toastr.warning(L('This profile type cannot be edited with switches'));
            return;
        }

        const choice = await chooseProfileSaveTarget();
        if (!choice) return;

        // V1：create 的名称输入必须先于缓冲应用——用户取消时不得改写运行时状态
        let deltaName: string | null = null;
        if (choice === 'create') {
            deltaName = await Popup.show.input(L('Derived profile name:'), '');
            if (!deltaName) return;
        }

        const preset = openai_settings[idx] as Preset;
        const snapshot = buildCommitSnapshot(ctx);
        const missing = applyBufferedEdits(preset, name, sessionEdits, pendingToggles);
        if (missing.length > 0) toastr.warning(`${L('Missing prompts skipped')}: ${missing.join(', ')}`);
        applyResolvedPromptState(preset, snapshot);

        if (choice === 'update') {
            // R1/F1：先删旧快照 fields 再提交——mergeBaseSnapshot 的 prior-copy 会把被清字段复活并随 saveMeta 落盘；
            // delta 路径由 snapshotToChanges 重建 changes 覆盖，此处先行删除亦无害
            applyPendingClearsToProfile(ctx.profile, pendingClears, name);
            const ok = await commitBufferedEditsToProfile(ctx.profile, snapshot, ctx.meta, name, idx, sessionEdits, 'full-changes');
            if (!ok) return;
        } else {
            const profiles = Array.isArray(ctx.meta.profiles) ? ctx.meta.profiles : [];
            const parentEntries = baselineStates;
            // previousChanges 传空：新建 delta 只存「相对父链解析状态」的净差异（本次快照 + 本次编辑），
            // 不冗余拷贝源 profile 已持久化的字段差异（否则数据膨胀/导出树冗余）。
            const deltaState = snapshotToDelta(snapshot, parentEntries);
            const derived = buildDerivedProfile(ctx.profile, deltaName as string, deltaState.changes);
            if (deltaState.order) derived.order = deltaState.order;
            profiles.push(derived);
            ctx.meta.profiles = profiles;
            recordDefaultOriginalFields(ctx.meta, name, sessionEdits);
            await saveMeta(name, idx, ctx.meta);
            toastr.success(L('Derived profile created'));
        }

        deps.refreshActivePresetUI(name);

        // 本批编辑已消费，清空当前 name 的记录（其他卡的缓冲保留）
        clearBuffers();
        reorderedIds.clear();
        reloadBaseline();
        editTargetId = null;
        mobileShowRight = false;

        // 重渲染弹窗（diff 清空）+ 刷新卡片网格
        await renderDialog();
        await deps.onGridRefresh();
    });

    dialog.on('click', '#pc-btn-close', function () {
        popup.completeCancelled();
    });

    dialog.on('input', '#pc-search-input', function () {
        searchQuery = String($(this).val() ?? '');
        applySearch();
        setupSortable(); // 搜索中禁用拖拽
    });

    // ---- 打开弹窗 ----
    await renderDialog();

    popup = new Popup(dialog, POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: false,
        transparent: true,
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });

    await popup.show();

    // R2/F6：关闭弹窗即结束本次编辑会话。缓冲仅存内存，任何重开（点击 profile = 重新加载）都会
    // 覆盖 preset 并清空缓冲，「缓冲保留可重开继续」不成立。无续编路径，确认与取消都清理——
    // 保留只会让孤儿缓冲在后续 add-base 等路径被静默吸收。
    if (stagedItems().length > 0) {
        const discard = await callGenericPopup(L('You have uncommitted changes. Discard them?'), POPUP_TYPE.CONFIRM);
        if (discard) {
            toastr.info(L('Uncommitted changes discarded'));
        }
        clearBuffers();
    }
}
