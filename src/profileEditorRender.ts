import { oai_settings } from '@sillytavern/scripts/openai';
import { renderExtensionTemplateAsync } from '@sillytavern/scripts/extensions';
import { EXTENSION_NAME } from './constants.js';
import { L } from './i18n.js';
import { readMeta, type Preset } from './meta.js';
import { bufferKey } from './presetBuffers.js';
import { capturePromptFields, filterFields, findPromptInPreset, promptFieldsEqual } from './promptToggle.js';
import { buildPromptEditForm } from './editModal.js';
import { buildBreadcrumb } from './profileEditorContext.js';
import { effectiveFieldsFor, resolveBaselineEntries } from './profileEditorBaseline.js';
import { applyUndoState, computeReorder, undoMount, undoReorderItem } from './profileEditorState.js';
import { stagedItems } from './profileEditorStaged.js';
import { resolveEditorSnapshot, type EditorContext, type EditorSnapshot } from './profileEditorContext.js';
import { applyNameWrap } from './nameWrap.js';

function cssEscape(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 重建后重应用锁定视觉（模板只传 label，类/图标/高亮由 JS 维护，跨 renderDialog 不丢）。
 * 锁定态只锁定顺序：禁止拖拽重排；开关/值编辑/挂载/清除/重置/Commit 均保持可用。 */
export function applyLockVisual(ctx: EditorContext): void {
    const btn = ctx.dialog.find('#pc-btn-lock');
    btn.toggleClass('active', ctx.listLocked);
    btn.attr('title', ctx.listLocked ? L('Unlock order') : L('Lock order'));
    btn.find('.pc-btn-label').text(ctx.listLocked ? L('Unlock order') : L('Lock order'));
    btn.find('i').attr('class', ctx.listLocked ? 'fa-solid fa-unlock' : 'fa-solid fa-lock');
    ctx.dialog.find('.pc-prompt-list').toggleClass('pc-locked', ctx.listLocked);
    ctx.dialog.find('#pc-btn-reset').toggle(true);
    ctx.dialog.find('#pc-btn-commit').toggle(true);
}

/** 把缓冲状态叠加到已渲染的条目列表（开关目标 / 编辑后的名字 / dirty 高亮）。 */
export function applyBufferOverlay(ctx: EditorContext): void {
    ctx.dialog.find('#pc-prompt-list .pc-prompt-card').each(function () {
        const entry = $(this);
        const identifier = String(entry.data('identifier'));
        const key = bufferKey(ctx.name, identifier);
        const toggleTarget = ctx.pendingToggles.get(key);
        const session = ctx.sessionEdits.get(key);

        const toggle = entry.find('.pc-btn-toggle:not(.mount)');
        if (toggle.length && toggleTarget !== undefined) {
            toggle.toggleClass('on', toggleTarget).toggleClass('off', !toggleTarget);
            toggle.html(toggleTarget
                ? '<i class="fa-solid fa-toggle-on"></i> On'
                : '<i class="fa-solid fa-toggle-off"></i> Off');
            entry.toggleClass('disabled', !toggleTarget);
        }
        if (session?.edited.name !== undefined) {
            entry.find('.pc-card-name').text(session.edited.name).attr('title', identifier);
            const idx = ctx.searchIndex.get(identifier);
            if (idx) idx.name = session.edited.name.toLowerCase();
        }
        if (ctx.sessionEdits.has(key) || ctx.pendingToggles.has(key) || ctx.pendingClears.has(key) || ctx.pendingMounts.has(key) || ctx.reorderedIds.has(identifier)) {
            entry.addClass('dirty');
        }
    });
    applyNameWrap(ctx.dialog);
}

/** 按搜索词过滤卡片。 */
/** 按搜索词过滤主列表卡片（staged 卡片在 diff 区，不参与搜索遍历）。 */
export function applySearch(ctx: EditorContext): void {
    const q = ctx.searchQuery.toLowerCase().trim();
    let visible = 0;
    ctx.dialog.find('#pc-prompt-list .pc-prompt-card').each(function () {
        const identifier = String($(this).data('identifier'));
        const idx = ctx.searchIndex.get(identifier);
        const match = !q || !!(idx && (idx.name.includes(q) || idx.content.includes(q) || identifier.toLowerCase().includes(q)));
        $(this).toggle(match);
        if (match) visible++;
    });
    ctx.dialog.find('#pc-prompt-empty-search').toggle(visible === 0 && q.length > 0);
}

/** 渲染右侧 staged diff 面板。 */
export function renderStagedPane(ctx: EditorContext, snapshot?: EditorSnapshot): void {
    const diffArea = ctx.dialog.find('#pc-diff-area');
    diffArea.empty();
    const items = stagedItems(ctx, snapshot);
    if (items.length === 0) {
        diffArea.append($('<div class="pc-diff-empty"></div>').text(L('No staged changes')));
        return;
    }
    diffArea.append($('<h3 class="pc-diff-title"></h3>').text(L('Staged Changes')));
    const list = $('<ul class="pc-diff-list"></ul>');
    for (const item of items) {
        // 每个条目：复用主列表的 prompt 卡片（序号/名称/角色/开关），只加一个 Undo 按钮
        let cls = 'diff-modify';
        if (item.reorder) cls = 'diff-reorder';
        else if (item.mount) cls = 'diff-mount';
        else if (item.toggle) cls = 'diff-toggle';
        else if (item.clear) cls = 'diff-clear';
        const li = $('<li class="pc-diff-item"></li>').addClass(cls);
        const enabledNow = ctx.pendingToggles.get(item.key) ?? item.entry?.enabled ?? true;
        const card = $('<div class="pc-prompt-card"></div>')
            .attr('data-identifier', item.identifier)
            .toggleClass('disabled', enabledNow === false);
        if (item.entry?.index !== undefined) {
            card.append($('<div class="pc-card-index"><span>' + item.entry.index + '</span></div>'));
        }
        // label/role 来自预设数据（导入的 delta changes.fields.role 可携带任意串）：
        // 走 attr/text 构建，禁止拼 HTML（cssEscape 只服务选择器，不是 HTML 转义）。
        const title = $('<div class="pc-card-title"></div>')
            .append($('<span class="pc-card-name"></span>').attr('title', item.label).text(item.label));
        if (item.entry?.role) {
            const role = String(item.entry.role);
            const roleClass = ['system', 'user', 'assistant'].includes(role) ? `role-${role}` : '';
            const badge = $('<span class="pc-role-badge"></span>').text(role);
            if (roleClass) badge.addClass(roleClass);
            title.append(badge);
        }
        card.append(title);
        // 开关组：Undo 在最前（撤销该条目），其后 enable 开关 / 闪电按钮（与主列表一致，staged 可交互）
        const switches = $('<div class="pc-card-switches"></div>');
        if (item.mount) {
            switches.append(buildUndoBtn(ctx, item.key, item.identifier, false, true));
        } else if (item.reorder) {
            switches.append(buildUndoBtn(ctx, item.key, item.identifier, false, false, true));
        } else if (item.clear) {
            // clear 项撤销：仅删 pendingClears（恢复被清除的值）
            switches.append(buildUndoBtn(ctx, item.key, item.identifier, true));
        } else {
            switches.append(buildUndoBtn(ctx, item.key, item.identifier));
        }
        if (item.entry?.toggleable) {
            switches.append($('<button class="pc-btn-toggle ' + (enabledNow ? 'on' : 'off') + '"><i class="fa-solid ' + (enabledNow ? 'fa-toggle-on' : 'fa-toggle-off') + '"></i></button>'));
        }
        if (ctx.pendingMounts.get(item.key) === true) {
            switches.append($('<button class="pc-btn-toggle mount on"><i class="fa-solid fa-bolt"></i></button>'));
        }
        card.append(switches);
        li.append(card);
        list.append(li);
    }
    diffArea.append(list);
}

/** 构建 Undo 图标按钮（clear 项独立 undo；mount 项撤销挂载；toggle/值编辑项整体撤销）。
 * forMount：true 时明确走 undoMount（撤销挂载态），避免与同条目 toggle 的 Undo 混淆。
 * forReorder：true 时走 undoReorderItem（还原单条目位置）。 */
export function buildUndoBtn(ctx: EditorContext, key: string, identifier: string, onlyClear = false, forMount = false, forReorder = false): JQuery<HTMLElement> {
    const undo = $('<button class="pc-btn-undo" title="' + cssEscape(L('Undo')) + '"></button>')
        .append($('<i class="fa-solid fa-rotate-left"></i>'));
    undo.on('click', async () => {
        if (onlyClear) {
            // 撤销清除：恢复 clear 时快照的会话编辑（session + toggle），否则被销毁的编辑无法还原
            ctx.pendingClears.delete(key);
            const cleared = ctx.clearedEdits.get(key);
            if (cleared) {
                if (cleared.session) ctx.sessionEdits.set(key, cleared.session);
                if (cleared.toggle !== undefined) {
                    ctx.pendingToggles.set(key, cleared.toggle);
                    const soEntry = ctx.sessionOrder.find((o) => o.identifier === identifier);
                    if (soEntry) soEntry.enabled = cleared.toggle;
                }
                ctx.clearedEdits.delete(key);
            }
        } else if (forMount) {
            // 撤销挂载态：精确还原该条目的挂载（不整表还原），重渲染分组
            undoMount(ctx, key, identifier);
            await renderDialog(ctx);
            refreshCounts(ctx);
            renderRightPane(ctx);
            return;
        } else if (forReorder) {
            // 撤销单条目 reorder：移回打开时位置
            undoReorderItem(ctx, identifier);
            await renderDialog(ctx);
            refreshCounts(ctx);
            renderRightPane(ctx);
            return;
        } else {
            applyUndoState(ctx, key, identifier);
        }
        refreshEntryRow(ctx, identifier);
        refreshCounts(ctx);
        renderRightPane(ctx);
    });
    return undo;
}

/** 右栏路由：有编辑目标 → 内联编辑表单；否则 staged diff。 */
export function renderRightPane(ctx: EditorContext, snapshot?: EditorSnapshot): void {
    ctx.dialog.find('.pc-layout').toggleClass('pc-show-right', ctx.mobileShowRight);
    ctx.dialog.find('.pc-layout').toggleClass('pc-editing', !!ctx.editTargetId);
    const diffArea = ctx.dialog.find('#pc-diff-area');
    const editArea = ctx.dialog.find('#pc-edit-area');
    if (ctx.editTargetId) {
        const resolvedCtx = snapshot ?? resolveEditorSnapshot(ctx);
        const view = resolvedCtx?.entries.find((e) => e.identifier === ctx.editTargetId);
        if (resolvedCtx && view?.editable) {
            editArea.empty().append(buildInlineEdit(ctx, resolvedCtx.preset, ctx.editTargetId));
            editArea.show();
            diffArea.hide();
            return;
        }
        // 条目不可编辑（system_prompt / marker / 缺失）→ 回退 staged 视图
        ctx.editTargetId = null;
        ctx.mobileShowRight = false;
    }
    editArea.hide();
    diffArea.show();
    renderStagedPane(ctx, snapshot);
    applyNameWrap(ctx.dialog);
}

/** 内联编辑表单（PC 右栏 / 手机全宽覆盖）：复用 editModal 的表单构造，保存写会话缓冲。 */
export function buildInlineEdit(ctx: EditorContext, preset: Preset, identifier: string): JQuery<HTMLElement> {
    const prompt = findPromptInPreset(preset, identifier);
    const wrap = $('<div class="pc-edit-form"></div>');
    if (!prompt) {
        wrap.append($('<div class="pc-diff-empty"></div>').text(L('No entries')));
        return wrap;
    }

    // 预填基线 = 有效值字段（出厂 ⊕ profile 解析）：注册投影流下父预设定义不代表编辑态，
    // 以定义预填会让用户「保存未改动」时把无关值写进 profile fields
    const baselineEntry = resolveBaselineEntries(ctx).find((e) => e.identifier === identifier);
    const effective = baselineEntry
        ? effectiveFieldsFor(readMeta(preset), baselineEntry, prompt)
        : capturePromptFields(prompt);

    const header = $('<div class="pc-editor-header"></div>');
    header.append($('<h3></h3>').text(prompt.name ?? identifier));
    applyNameWrap(header);
    const actions = $('<div class="pc-editor-actions"></div>');

    const prevSession = ctx.sessionEdits.get(bufferKey(ctx.name, identifier));
    const current = prevSession ? { ...effective, ...prevSession.edited } : { ...effective };
    // 锁定态只锁顺序，编辑表单始终可编辑
    const form = buildPromptEditForm(preset, identifier, current, false);

    const saveBtn = $('<button class="pc-btn-icon pc-btn-icon-primary" title="' + L('Save') + '"></button>')
        .append($('<i class="fa-solid fa-save"></i>'))
        .append(' ' + L('Save'));
    const cancelBtn = $('<button class="pc-btn-icon" title="' + L('Cancel') + '"></button>')
        .append($('<i class="fa-solid fa-times"></i>'))
        .append(' ' + L('Cancel'));

    saveBtn.on('click', () => {
        const editedFields = form.collectFields();
        if (editedFields) {
            const key = bufferKey(ctx.name, identifier);
            // F2：clear 后重新编辑视为覆盖「清除」意图（clear 快照一并丢弃）
            ctx.pendingClears.delete(key);
            ctx.clearedEdits.delete(key);
            const session = ctx.sessionEdits.get(key);
            const initial = session?.initial ?? { ...effective };
            const edited = { ...(session?.edited ?? {}), ...filterFields(editedFields) };
            if (promptFieldsEqual(edited, initial)) {
                ctx.sessionEdits.delete(key);
            } else {
                ctx.sessionEdits.set(key, { initial, edited });
            }
        }
        ctx.editTargetId = null;
        ctx.mobileShowRight = false;
        refreshEntryRow(ctx, identifier);
        refreshCounts(ctx);
        renderRightPane(ctx);
    });
    cancelBtn.on('click', () => {
        ctx.editTargetId = null;
        ctx.mobileShowRight = false;
        renderRightPane(ctx);
    });

    actions.append(saveBtn).append(cancelBtn);
    header.append(actions);
    wrap.append(header);
    wrap.append(form.container);
    return wrap;
}

/** 局部刷新单条 entry（名字/开关/dirty/clear 可见性）。 */
export function refreshEntryRow(ctx: EditorContext, identifier: string, snapshot?: EditorSnapshot): void {
    const row = ctx.dialog.find(`#pc-prompt-list .pc-prompt-card[data-identifier="${cssEscape(identifier)}"]`);
    if (row.length === 0) return;
    const resolvedCtx = snapshot ?? resolveEditorSnapshot(ctx);
    const view = resolvedCtx?.entries.find((e) => e.identifier === identifier);
    const key = bufferKey(ctx.name, identifier);
    const toggleTarget = ctx.pendingToggles.get(key);
    const session = ctx.sessionEdits.get(key);
    const enabled = toggleTarget ?? view?.enabled ?? true;
    const displayName = session?.edited.name ?? view?.name ?? identifier;

    row.find('.pc-card-name').text(displayName).attr('title', identifier);
    const idx = ctx.searchIndex.get(identifier);
    if (idx) idx.name = displayName.toLowerCase();

    const toggle = row.find('.pc-btn-toggle:not(.mount)');
    if (toggle.length) {
        toggle.toggleClass('on', enabled).toggleClass('off', !enabled);
        toggle.html(enabled ? '<i class="fa-solid fa-toggle-on"></i>' : '<i class="fa-solid fa-toggle-off"></i>');
    }

    const clearBtn = row.find('.pc-card-clear');
    const shouldHaveClear = !!view?.clearable;
    if (shouldHaveClear && clearBtn.length === 0) {
        const btn = $('<button class="pc-card-clear" title="' + L('Clear value changes') + '"><i class="fa-solid fa-eraser"></i></button>');
        const toggleEl = row.find('.pc-btn-toggle:not(.mount)');
        if (toggleEl.length) btn.insertBefore(toggleEl);
        else row.append(btn);
    } else if (!shouldHaveClear) {
        clearBtn.remove();
    }

    row.toggleClass('disabled', !enabled);
    row.toggleClass('dirty', ctx.sessionEdits.has(key) || ctx.pendingToggles.has(key) || ctx.pendingClears.has(key) || ctx.pendingMounts.has(key) || ctx.reorderedIds.has(identifier));
    row.toggleClass('persistent', !!view?.hasPersistentDiff);
    applyNameWrap(row);
}

/** staged 计数 + commit 按钮禁用态。 */
export function refreshCounts(ctx: EditorContext, snapshot?: EditorSnapshot): void {
    const n = stagedItems(ctx, snapshot).length;
    ctx.dialog.find('.pc-btn-view-staged .pc-staged-count').text(`(${n})`);
    // 有 staged diff 时 View Staged 按钮高亮提示（可提交）
    ctx.dialog.find('.pc-btn-view-staged').toggleClass('has-staged', n > 0);
    const commitBtn = ctx.dialog.find('#pc-btn-commit');
    commitBtn.prop('disabled', n === 0);
    commitBtn.toggleClass('disabled', n === 0);
}

/** 渲染整个弹窗。 */
export async function renderDialog(ctx: EditorContext): Promise<void> {
    const snapshot = resolveEditorSnapshot(ctx);
    if (!snapshot) return;
    const items = stagedItems(ctx, snapshot);
    const { items: breadcrumb, title: breadcrumbTitle } = buildBreadcrumb(snapshot.profile, snapshot.meta);
    // 挂载/未挂载分组：unused 收进折叠区（模板各渲染一段）。
    // mountedPending：本会话刚从 unmounted 激活的条目（pendingMounts 目标=挂载）——这类条目闪电按钮 + 开关并存，
    // 普通已挂载 prompt 只有开关（无闪电按钮，见 profile-editor.html 条件渲染）。
    const pendingMountedIds = new Set<string>();
    for (const [k, target] of ctx.pendingMounts) {
        if (k.startsWith(ctx.prefix) && target === true) pendingMountedIds.add(k.slice(ctx.prefix.length));
    }
    const entries = snapshot.entries
        .filter((e) => e.mounted)
        .map((e) => ({ ...e, mountedPending: pendingMountedIds.has(e.identifier) }));
    const unusedEntries = snapshot.entries.filter((e) => !e.mounted);

    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'profile-editor', {
        presetName: ctx.name,
        breadcrumb,
        breadcrumbTitle,
        entries,
        unusedEntries,
        stagedCount: items.length,
        canCommit: items.length > 0,
        listLocked: ctx.listLocked,
        readOnly: snapshot.readOnly,
        i18n: {
            rename: L('Rename'),
            lockList: ctx.listLocked ? L('Unlock list') : L('Lock list'),
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
            unusedPrompts: L('Unused prompts'),
            activatePrompt: L('Activate prompt'),
        },
    });

    const newDialog = $(html);
    const children = newDialog.children().toArray();
    // 重建前记录列表滚动位置，重建后还原（编辑/commit 后不跳回顶部）
    const listEl = ctx.dialog.find('.pc-prompt-list');
    const prevScrollTop = listEl.length ? listEl.scrollTop() ?? 0 : 0;
    ctx.dialog.empty().append(children);

    rebuildSearchIndex(ctx);
    applyBufferOverlay(ctx);
    applySearch(ctx);
    // R4：commit 后 renderDialog 重建模板，输入框无 value——按 searchQuery 回填，与过滤结果一致
    ctx.dialog.find('#pc-search-input').val(ctx.searchQuery);
    applyLockVisual(ctx);
    const newListEl = ctx.dialog.find('.pc-prompt-list');
    if (newListEl.length) {
        // 条目数变化（搜索过滤/commit）时 clamp，避免 scrollTop 超界漂移
        const maxScroll = Math.max(0, (newListEl[0].scrollHeight ?? 0) - (newListEl[0].clientHeight ?? 0));
        newListEl.scrollTop(Math.min(prevScrollTop, maxScroll));
    }
    renderRightPane(ctx, snapshot);
    setupSortable(ctx);
    refreshCounts(ctx, snapshot);
    applyNameWrap(ctx.dialog);
}

/** 搜索索引：由 entries 重建（一次构建，applySearch 只读缓存）。 */
export function rebuildSearchIndex(ctx: EditorContext): void {
    const snapshot = resolveEditorSnapshot(ctx);
    ctx.searchIndex = new Map((snapshot?.entries ?? []).map((e) => [
        e.identifier,
        { name: (e.name ?? '').toLowerCase(), content: (e.content ?? '').toLowerCase() },
    ]));
}

/** 拖拽排序：仅活动预设可拖；拖拽后立即落盘（不进 diff）。锁定/只读状态禁止排序。 */
export function setupSortable(ctx: EditorContext): void {
    const listEl = ctx.dialog.find('.pc-prompt-list');
    if (!listEl.length) return;
    const isActive = oai_settings.preset_settings_openai === ctx.name;
    const readOnly = !!resolveEditorSnapshot(ctx)?.readOnly;
    const shouldSortable = isActive && !ctx.searchQuery && !ctx.listLocked && !readOnly;
    const isSortable = !!listEl.data('ui-sortable');
    if (isSortable && !shouldSortable) listEl.sortable('destroy');
    if (shouldSortable && !isSortable) {
        listEl.sortable({
            axis: 'y',
            handle: '.pc-drag-handle',
            // 仅直接子级卡片可拖：unused 分组嵌在 .pc-prompt-list 内，避免其卡片被 sortable 捕获/拖拽错位
            items: '> .pc-prompt-card',
            placeholder: 'pc-sortable-placeholder',
            start: () => listEl.addClass('sorting'),
            stop: () => listEl.removeClass('sorting'),
            update: () => { void onReorder(ctx, listEl); },
        });
    }
}

/** 拖拽重排：读 DOM 顺序 → 纯计算 → 更新会话 sessionOrder + reorderedIds（进 diff，Commit 才落盘）。 */
export async function onReorder(ctx: EditorContext, listEl: JQuery<HTMLElement>): Promise<void> {
    if (ctx.listLocked) return;
    if (resolveEditorSnapshot(ctx)?.readOnly) return;

    const domIds = listEl.find('.pc-prompt-card').map(function () {
        return String($(this).data('identifier'));
    }).get();
    const result = computeReorder(ctx, domIds);
    if (!result) return;

    for (const change of result.dirtyChanges) {
        if (change.dirty) ctx.reorderedIds.add(change.identifier);
        else ctx.reorderedIds.delete(change.identifier);
        refreshEntryRow(ctx, change.identifier);
    }

    // 单向数据流：只改会话 sessionOrder，预设 prompt_order 不动（Commit 时随 profile.order 落盘）
    ctx.sessionOrder = result.order.map((o) => ({ ...o }));
    refreshCardIndexes(listEl, result.order);
    // 刷新 staged 计数与 commit 按钮（reorder 计入 diff）
    refreshCounts(ctx);
    renderRightPane(ctx);
}

/** 拖拽落盘后按新顺序重写各卡片序号（01/02/…），避免等下次全量重渲染才刷新。 */
function refreshCardIndexes(listEl: JQuery<HTMLElement>, order: { identifier: string }[]): void {
    const idxById = new Map(order.map((o, i) => [o.identifier, i]));
    listEl.find('.pc-prompt-card').each(function () {
        const idx = idxById.get(String($(this).data('identifier')));
        const span = $(this).find('.pc-card-index > span');
        if (idx !== undefined && span.length) span.text(String(idx + 1).padStart(2, '0'));
    });
}
