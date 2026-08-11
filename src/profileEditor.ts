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
    type PromptFields,
} from './meta.js';
import {
    PROMPT_FIELD_WHITELIST,
    applyBaseProfile,
    buildPromptSnapshot,
    capturePromptFields,
    captureSampling,
    filterFields,
    findOrderList,
    findPromptInPreset,
    promptFieldsEqual,
    resolveParentStates,
    resolveProfilePrompts,
    resolvePromptOrderTarget,
    snapshotToChanges,
} from './promptToggle.js';
import {
    applyBufferedEdits,
    bufferKey,
    bufferPrefix,
    clearBufferedForName,
    editedIdentifiersForName,
    type PromptEditBuffer,
} from './presetBuffers.js';
import { applyDefaultExtra, applyDefaultOriginalFields, defaultEnabledEntries, mergeBaseSnapshot, recordDefaultOriginalFields } from './presetSnapshot.js';
import { buildDerivedProfile } from './profileActions.js';
import { chooseProfileSaveTarget } from './importExport.js';
import { buildProfileEntries, buildProfileOrderCtx, type ProfileEntryView, type ProfileOrderCtx } from './presetList.js';
import { buildPromptEditForm } from './editModal.js';

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
): { identifier: string; enabled: boolean; fields?: PromptFields }[] {
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
    snapshot: { identifier: string; enabled: boolean; fields?: PromptFields }[],
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
            profile.changes = snapshotToChanges(snapshot, parentEntries, profile.changes);
        } else if (missingParent === 'full-changes') {
            // 父链缺失：全量写成差异（含值字段）；空 fields（clear 条目）不写入（F3）
            profile.changes = snapshot.map((s) => {
                const change: PromptDeltaChange = { identifier: s.identifier, enabled: s.enabled };
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

/** 面包屑的一项：节点名 + 是否当前节点。 */
export interface BreadcrumbItem {
    name: string;
    isCurrent: boolean;
}

// 构建三段式面包屑「父 ▸ 当前 ▸ 子」：父取当前节点直接上级（沿 baseId 链向上收集，取最近一个），
// 子取当前节点第一个直接派生（meta.profiles 中 baseId 指向当前 id 的 delta）。无父/无子则对应段省略。
// title 保留完整派生链（全部祖先 ▸ 当前 ▸ 子），hover 时不丢信息。
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

    const ancestors = chain.slice(0, -1);
    const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1] : undefined;
    const child = (Array.isArray(meta.profiles) ? meta.profiles : []).find(
        (candidate) => isPromptDeltaProfile(candidate) && String(candidate.baseId) === String(profile.id),
    );
    const childName = child ? child.name : undefined;

    const title = [
        ...ancestors.map((item) => item.name),
        profile.name,
        ...(childName ? [childName] : []),
    ].join(' ▸ ');

    const items: BreadcrumbItem[] = [];
    if (parent) items.push({ name: parent.name, isCurrent: false });
    items.push({ name: profile.name, isCurrent: true });
    if (childName) items.push({ name: childName, isCurrent: false });
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
    /** 会话级列表锁定：锁定后禁止编辑（进入编辑/clear）与拖拽排序，开关保持可用；关弹窗即重置。 */
    let listLocked = false;
    /** 本会话拖拽重排过的条目（打脏标记，立即保存不进 diff；序号保持不更新）。 */
    const reorderedIds = new Set<string>();
    /** R1：本会话「清除值变更」缓冲（key = bufferKey(name, identifier)）；Commit 才删除 profile 快照 fields。 */
    const pendingClears = new Map<string, true>();
    /** 弹窗打开时的 prompt_order 快照：拖拽脏标记的基准（改回原位则清除）。
     * R7：复用 buildProfileOrderCtx 的顺序索引构建（非活动预设返回空 map；拖拽本就仅活动预设开放）。 */
    const initialOrderIndex = buildProfileOrderCtx(openai_settings[idx] as Preset, oai_settings.preset_settings_openai === name).orderIndex;
    let popup: Popup;

    // 读取当前预设/元数据/profile 解析后的展示条目（每次调用取最新内存态，clear 等直接改内存对象）
    const currentCtx = (): { preset: Preset; meta: PresetMeta; profile: PromptBaseProfile | PromptDeltaProfile; entries: ProfileEntryView[]; orderCtx: ProfileOrderCtx } | undefined => {
        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile || (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile))) return undefined;
        const isActive = oai_settings.preset_settings_openai === name;
        const orderCtx = buildProfileOrderCtx(preset, isActive);
        return { preset, meta, profile, entries: buildProfileEntries(profile, meta, preset, orderCtx), orderCtx };
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
        const enabledById = new Map(resolvedCtx.entries.map((e) => [e.identifier, e.enabled]));

        const keys = new Set<string>();
        for (const k of pendingToggles.keys()) if (k.startsWith(prefix)) keys.add(k);
        for (const k of sessionEdits.keys()) if (k.startsWith(prefix)) keys.add(k);
        for (const k of pendingClears.keys()) if (k.startsWith(prefix)) keys.add(k);

        const items: StagedItem[] = [];
        for (const key of keys) {
            const identifier = key.slice(prefix.length);
            const item: StagedItem = { identifier, key, label: nameById.get(identifier) ?? identifier, fields: [] };
            const toggleTarget = pendingToggles.get(key);
            if (toggleTarget !== undefined) {
                item.toggle = { original: enabledById.get(identifier) ?? true, target: toggleTarget };
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
            entries: ctx.entries,
            stagedCount: items.length,
            canCommit: items.length > 0,
            listLocked,
            i18n: {
                rename: L('Rename'),
                lockList: listLocked ? L('Unlock list') : L('Lock list'),
                viewStaged: L('View Staged'),
                reset: L('Reset to parent'),
                commit: L('Commit'),
                close: L('Close'),
                back: L('Back'),
                searchPrompts: L('Search prompts...'),
                dragHandle: L('Drag to reorder'),
                clearValueChange: L('Clear value changes'),
                toggleEntry: L('Toggle entry'),
                noEntries: L('No entries'),
                noSearchResults: L('No prompts found'),
            },
        });

        const newDialog = $(html);
        // 模板根节点是 #preset_profile_editor：取其子节点填入 dialog，保持 dialog 元素身份稳定
        //（delegated 事件绑定不丢，id/样式仍作用于 dialog 本身）
        const children = newDialog.children().toArray();
        // 重建前记录列表滚动位置，重建后还原（编辑/commit 后不跳回顶部）
        const listEl = dialog.find('.pc-prompt-list');
        const prevScrollTop = listEl.length ? listEl.scrollTop() ?? 0 : 0;
        dialog.empty().append(children);

        rebuildSearchIndex();
        applyBufferOverlay();
        applySearch();
        // R4：commit 后 renderDialog 重建模板，输入框无 value——按闭包 searchQuery 回填，与过滤结果一致
        dialog.find('#pc-search-input').val(searchQuery);
        applyLockVisual();
        const newListEl = dialog.find('.pc-prompt-list');
        if (newListEl.length) {
            // 条目数变化（搜索过滤/commit）时 clamp，避免 scrollTop 超界漂移
            const maxScroll = Math.max(0, (newListEl[0].scrollHeight ?? 0) - (newListEl[0].clientHeight ?? 0));
            newListEl.scrollTop(Math.min(prevScrollTop, maxScroll));
        }
        renderRightPane(ctx);
        setupSortable();
        refreshCounts(ctx);
    }

    // 重建后重应用锁定视觉（模板只传 label，类/图标/高亮由 JS 维护，跨 renderDialog 不丢）
    function applyLockVisual(): void {
        const btn = dialog.find('#pc-btn-lock');
        btn.toggleClass('active', listLocked);
        btn.attr('title', listLocked ? L('Unlock list') : L('Lock list'));
        btn.find('.pc-btn-label').text(listLocked ? L('Unlock list') : L('Lock list'));
        btn.find('i').attr('class', listLocked ? 'fa-solid fa-unlock' : 'fa-solid fa-lock');
        dialog.find('.pc-prompt-list').toggleClass('pc-locked', listLocked);
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
            if (sessionEdits.has(key) || pendingToggles.has(key) || pendingClears.has(key) || reorderedIds.has(identifier)) {
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
            if (listLocked) return;
            // clear 项独立 undo（仅撤销 pendingClears；profile 快照 fields 未动，恢复即自然）；
            // toggle/值编辑项仍按原语义整体撤销
            if (onlyClear) {
                pendingClears.delete(key);
            } else {
                undoStaged(key, identifier);
            }
            refreshEntryRow(identifier);
            refreshCounts();
            renderRightPane();
        });
        return undo;
    }

    // 右栏路由：有编辑目标 → 内联编辑表单；否则 staged diff。
    // 手机端（≤768px）默认右栏隐藏，mobileShowRight 时加 .pc-show-right 让右栏全宽覆盖列表。
    // pc-editing：编辑表单态（编辑表单自带 Save/Cancel，无需 header 提供退出，手机端隐藏左栏 header 省高度）；
    // diff 视图保留 header（含 commit/reset/close 退出入口）。
    function renderRightPane(ctx?: EditorCtx): void {
        dialog.find('.pc-layout').toggleClass('pc-show-right', mobileShowRight);
        dialog.find('.pc-layout').toggleClass('pc-editing', !!editTargetId);
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
            if (listLocked) return;
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

        actions.append(saveBtn).append(cancelBtn);
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
        row.toggleClass('dirty', sessionEdits.has(key) || pendingToggles.has(key) || pendingClears.has(key) || reorderedIds.has(identifier));
        row.toggleClass('persistent', !!view?.hasPersistentDiff);
    }

    // Undo 某条缓冲：撤销 toggle 目标 + 还原值编辑（镜像 clear 的 full undo）
    function undoStaged(key: string, identifier: string): void {
        pendingToggles.delete(key);
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
        refreshEntryRow(identifier);
        refreshCounts();
        renderRightPane();
    }

    // 拖拽排序：仅活动预设可拖；拖拽后立即落盘（不进 diff）。锁定状态禁止排序。
    function setupSortable(): void {
        const listEl = dialog.find('.pc-prompt-list');
        if (!listEl.length) return;
        const isActive = oai_settings.preset_settings_openai === name;
        const shouldSortable = isActive && !searchQuery && !listLocked;
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
                update: () => { void onReorder(listEl); },
            });
        }
    }

    async function onReorder(listEl: JQuery<HTMLElement>): Promise<void> {
        if (listLocked) return;
        const preset = openai_settings[idx] as Preset;
        const orderList = findOrderList(preset, resolvePromptOrderTarget());
        if (!orderList || !Array.isArray(orderList.order)) return;

        const domIds = listEl.find('.pc-prompt-card').map(function () {
            return String($(this).data('identifier'));
        }).get();
        const order = orderList.order as { identifier: string }[];
        const inDom = new Set(domIds);
        // R9：O(n) 建索引，避免 domIds.map(id => order.find(...)) 的 O(n²)
        const byId = new Map(order.map((o) => [o.identifier, o]));
        const newOrder = [
            ...domIds.map((id) => byId.get(id)).filter((o): o is { identifier: string } => !!o),
            ...order.filter((o) => !inDom.has(o.identifier)),
        ];
        if (newOrder.length === order.length && newOrder.every((o, i) => o.identifier === order[i].identifier)) return;

        // 相对弹窗打开时的原始顺序重算脏标记：位置变化的标脏，改回原位的清除
        const newIndex = new Map(newOrder.map((o, i) => [o.identifier, i]));
        for (const o of newOrder) {
            const dirtyNow = initialOrderIndex.get(o.identifier) !== newIndex.get(o.identifier);
            const wasDirty = reorderedIds.has(o.identifier);
            if (dirtyNow !== wasDirty) {
                if (dirtyNow) reorderedIds.add(o.identifier);
                else reorderedIds.delete(o.identifier);
                refreshEntryRow(o.identifier);
            }
        }

        orderList.order = newOrder;
        await saveMeta(name, idx, readMeta(preset));
        deps.refreshActivePresetUI(name);
    }

    function refreshCounts(ctx?: EditorCtx): void {
        const n = stagedItems(ctx).length;
        dialog.find('.pc-btn-view-staged .pc-staged-count').text(`(${n})`);
        const commitBtn = dialog.find('#pc-btn-commit');
        commitBtn.prop('disabled', n === 0);
        commitBtn.toggleClass('disabled', n === 0);
    }

    // 清空当前 name 的全部会话缓冲（含 pendingClears）：commit 消费后与关闭丢弃时共用
    const clearBuffers = (): void => {
        clearBufferedForName(name, sessionEdits, pendingToggles);
        pendingClears.clear();
    };

    // ---- 事件（delegated，重渲染 innerHTML 后仍然有效） ----
    dialog.on('click', '.pc-prompt-card', function (e) {
        if (listLocked) return;
        if ($(e.target).closest('.pc-drag-handle, .pc-card-clear, .pc-btn-toggle, button').length) return;
        const identifier = String($(this).data('identifier'));
        const ctx = currentCtx();
        const view = ctx?.entries.find((x) => x.identifier === identifier);
        if (!view?.editable) return; // system_prompt / marker 不渲染编辑
        editTargetId = identifier;
        mobileShowRight = true;
        renderRightPane();
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
            const resolved = resolveProfilePrompts(ctx.profile, ctx.meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[], new Set());
            resolvedEnabled = resolved.find((x) => x.identifier === identifier)?.enabled;
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
        if (listLocked) return;
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

    dialog.on('click', '.pc-btn-view-staged', function () {
        editTargetId = null;
        mobileShowRight = true;
        renderRightPane();
    });

    // 手机端暂存视图：隐藏搜索栏，返回按钮退回列表视图
    dialog.on('click', '#pc-btn-back', function () {
        editTargetId = null;
        mobileShowRight = false;
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

    // ---- Reset to parent（delta → 上级；base → 隐藏默认）----
    dialog.on('click', '#pc-btn-reset', async function () {
        const ctx = currentCtx();
        if (!ctx) return;
        if (!isPromptBaseProfile(ctx.profile) && !isPromptDeltaProfile(ctx.profile)) {
            toastr.warning(L('This profile type cannot be reset'));
            return;
        }

        const confirm = await callGenericPopup(L('Reset this configuration to its parent?'), POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile) return;

        if (isPromptDeltaProfile(profile)) {
            // 派生：回退到其上级（base 或上层 delta）；若无上级则回退到隐藏默认
            const parentStates = resolveParentStates(profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]);
            if (parentStates.length > 0) {
                applyBaseProfile(preset, {
                    formatVersion: 2,
                    kind: 'prompt_base',
                    id: profile.baseId || 'parent',
                    name: 'Parent',
                    prompts: parentStates,
                });
                profile.changes = [];
                // reset 回退到父链：采样快照一并清除，避免下次加载复活旧采样覆盖预设当前值
                delete profile.sampling;
                // 预设附加键还原到出厂基线；profile 自身 extra 为保留存档，reset 不改
                applyDefaultExtra(preset, meta);
            } else {
                if (!meta.defaultSnapshot || meta.defaultSnapshot.length === 0) {
                    toastr.warning(L('No default baseline available'));
                    return;
                }
                applyDefaultOriginalFields(preset, meta);
                applyDefaultExtra(preset, meta);
                const defaultPrompts = defaultEnabledEntries(preset, meta);
                applyBaseProfile(preset, {
                    formatVersion: 2,
                    kind: 'prompt_base',
                    id: profile.baseId || 'default',
                    name: 'Default',
                    prompts: defaultPrompts,
                });
                profile.changes = [];
                delete profile.sampling;
            }
            await saveMeta(name, idx, meta);
            toastr.success(L('Configuration reset'));
            deps.refreshActivePresetUI(name);
        } else if (isPromptBaseProfile(profile)) {
            // 主 profile：回退到隐藏默认基准
            if (!meta.defaultSnapshot || meta.defaultSnapshot.length === 0) {
                toastr.warning(L('No default baseline available'));
                return;
            }
            applyDefaultOriginalFields(preset, meta);
            applyDefaultExtra(preset, meta);
            // 只回写开关；originalFields 是 reset 专用元数据，不随 profile 持久化
            const defaultPrompts = defaultEnabledEntries(preset, meta);
            profile.prompts = structuredClone(defaultPrompts);
            delete profile.sampling;
            applyBaseProfile(preset, {
                formatVersion: 2,
                kind: 'prompt_base',
                id: profile.id,
                name: profile.name,
                prompts: defaultPrompts,
            });
            await saveMeta(name, idx, meta);
            toastr.success(L('Configuration reset'));
            deps.refreshActivePresetUI(name);
        }

        // reset 已消费本会话缓冲：清空并重载基线、重渲染弹窗 + 刷新卡片网格
        clearBuffers();
        reorderedIds.clear();
        editTargetId = null;
        mobileShowRight = false;
        await renderDialog();
        await deps.onGridRefresh();
    });

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
        const snapshot = applyBufferedAndSnapshot(preset, name, sessionEdits, pendingToggles, pendingClears);

        if (choice === 'update') {
            // R1/F1：先删旧快照 fields 再提交——mergeBaseSnapshot 的 prior-copy 会把被清字段复活并随 saveMeta 落盘；
            // delta 路径由 snapshotToChanges 重建 changes 覆盖，此处先行删除亦无害
            applyPendingClearsToProfile(ctx.profile, pendingClears, name);
            const ok = await commitBufferedEditsToProfile(ctx.profile, snapshot, ctx.meta, name, idx, sessionEdits, 'full-changes');
            if (!ok) return;
        } else {
            const profiles = Array.isArray(ctx.meta.profiles) ? ctx.meta.profiles : [];
            const parentEntries = resolveProfilePrompts(ctx.profile, ctx.meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[], new Set());
            // previousChanges 传空：新建 delta 只存「相对父链解析状态」的净差异（本次快照 + 本次编辑），
            // 不冗余拷贝源 profile 已持久化的字段差异（否则数据膨胀/导出树冗余）。
            const changes = snapshotToChanges(snapshot, parentEntries, []);
            profiles.push(buildDerivedProfile(ctx.profile, deltaName as string, changes, captureSampling(preset) ?? undefined));
            ctx.meta.profiles = profiles;
            recordDefaultOriginalFields(ctx.meta, name, sessionEdits);
            await saveMeta(name, idx, ctx.meta);
            toastr.success(L('Derived profile created'));
        }

        deps.refreshActivePresetUI(name);

        // 本批编辑已消费，清空当前 name 的记录（其他卡的缓冲保留）
        clearBuffers();
        reorderedIds.clear();
        editTargetId = null;
        mobileShowRight = false;

        // 重渲染弹窗（diff 清空）+ 刷新卡片网格
        await renderDialog();
        await deps.onGridRefresh();
    });

    dialog.on('click', '#pc-btn-close', async function () {
        if (stagedItems().length > 0) {
            const discard = await callGenericPopup(L('You have uncommitted changes. Discard them?'), POPUP_TYPE.CONFIRM);
            if (!discard) return;
            toastr.info(L('Uncommitted changes discarded'));
            clearBuffers();
        }
        popup.completeCancelled();
    });

    dialog.on('click', '#pc-btn-lock', function () {
        listLocked = !listLocked;
        applyLockVisual();
        // 锁定时退出当前编辑视图（编辑表单 Save/Cancel 不再可用）并禁用拖拽
        if (listLocked) {
            editTargetId = null;
            mobileShowRight = false;
            renderRightPane();
        }
        setupSortable();
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
    // 覆盖 preset 并清空缓冲，「缓冲保留可重开继续」不成立。无续编路径，统一清理——
    // 按钮退出已先确认并清缓冲；此处兜底 Escape/其他关闭路径仍有未提交改动时提示丢弃，避免孤儿缓冲被静默吸收。
    if (stagedItems().length > 0) {
        const discard = await callGenericPopup(L('You have uncommitted changes. Discard them?'), POPUP_TYPE.CONFIRM);
        if (discard) {
            toastr.info(L('Uncommitted changes discarded'));
        }
        clearBuffers();
    }
}
