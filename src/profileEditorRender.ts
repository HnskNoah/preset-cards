import { oai_settings, openai_settings } from '@sillytavern/scripts/openai';
import { renderExtensionTemplateAsync } from '@sillytavern/scripts/extensions';
import { EXTENSION_NAME } from './constants.js';
import { L } from './i18n.js';
import { readMeta, saveMeta } from './meta.js';
import type { Preset } from './meta.js';
import { bufferKey } from './presetBuffers.js';
import { capturePromptFields, filterFields, findOrderList, findPromptInPreset, promptFieldsEqual, resolvePromptOrderTarget } from './promptToggle.js';
import { buildPromptEditForm } from './editModal.js';
import { buildBreadcrumb } from './profileEditorContext.js';
import { applyUndoState, computeReorder, stagedItems } from './profileEditorState.js';
import { resolveEditorSnapshot, type EditorContext, type EditorSnapshot } from './profileEditorContext.js';

function cssEscape(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 重建后重应用锁定视觉（模板只传 label，类/图标/高亮由 JS 维护，跨 renderDialog 不丢）。 */
export function applyLockVisual(ctx: EditorContext): void {
    const btn = ctx.dialog.find('#pc-btn-lock');
    btn.toggleClass('active', ctx.listLocked);
    btn.attr('title', ctx.listLocked ? L('Unlock list') : L('Lock list'));
    btn.find('.pc-btn-label').text(ctx.listLocked ? L('Unlock list') : L('Lock list'));
    btn.find('i').attr('class', ctx.listLocked ? 'fa-solid fa-unlock' : 'fa-solid fa-lock');
    ctx.dialog.find('.pc-prompt-list').toggleClass('pc-locked', ctx.listLocked);
}

/** 把缓冲状态叠加到已渲染的条目列表（开关目标 / 编辑后的名字 / dirty 高亮）。 */
export function applyBufferOverlay(ctx: EditorContext): void {
    ctx.dialog.find('.pc-prompt-card').each(function () {
        const entry = $(this);
        const identifier = String(entry.data('identifier'));
        const key = bufferKey(ctx.name, identifier);
        const toggleTarget = ctx.pendingToggles.get(key);
        const session = ctx.sessionEdits.get(key);

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
            const idx = ctx.searchIndex.get(identifier);
            if (idx) idx.name = session.edited.name.toLowerCase();
        }
        if (ctx.sessionEdits.has(key) || ctx.pendingToggles.has(key) || ctx.pendingClears.has(key) || ctx.reorderedIds.has(identifier)) {
            entry.addClass('dirty');
        }
    });
}

/** 按搜索词过滤卡片。 */
export function applySearch(ctx: EditorContext): void {
    const q = ctx.searchQuery.toLowerCase().trim();
    let visible = 0;
    ctx.dialog.find('.pc-prompt-card').each(function () {
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
        if (item.toggle) {
            list.append($('<li class="pc-diff-item diff-toggle"></li>')
                .append($('<span class="pc-diff-desc"></span>').text(`${item.label}: ${L('Switch')} ${item.toggle.original ? L('On') : L('Off')} → ${item.toggle.target ? L('On') : L('Off')}`))
                .append(buildUndoBtn(ctx, item.key, item.identifier)));
        }
        for (const f of item.fields) {
            list.append($('<li class="pc-diff-item diff-modify"></li>')
                .append($('<span class="pc-diff-desc"></span>').text(`${item.label}: ${f.from || '∅'} → ${f.to || '∅'}`))
                .append(buildUndoBtn(ctx, item.key, item.identifier)));
        }
        if (item.clear) {
            list.append($('<li class="pc-diff-item diff-clear"></li>')
                .append($('<span class="pc-diff-desc"></span>').text(`${item.label}: ${L('Clear value changes')}`))
                .append(buildUndoBtn(ctx, item.key, item.identifier, true)));
        }
    }
    diffArea.append(list);
}

/** 构建 Undo 按钮（clear 项独立 undo；toggle/值编辑项整体撤销）。 */
export function buildUndoBtn(ctx: EditorContext, key: string, identifier: string, onlyClear = false): JQuery<HTMLElement> {
    const undo = $('<button class="pc-btn-undo"></button>')
        .append($('<i class="fa-solid fa-rotate-left"></i>'))
        .append(' ' + L('Undo'));
    undo.on('click', () => {
        if (ctx.listLocked) return;
        if (onlyClear) {
            ctx.pendingClears.delete(key);
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
}

/** 内联编辑表单（PC 右栏 / 手机全宽覆盖）：复用 editModal 的表单构造，保存写会话缓冲。 */
export function buildInlineEdit(ctx: EditorContext, preset: Preset, identifier: string): JQuery<HTMLElement> {
    const prompt = findPromptInPreset(preset, identifier);
    const wrap = $('<div class="pc-edit-form"></div>');
    if (!prompt) {
        wrap.append($('<div class="pc-diff-empty"></div>').text(L('No entries')));
        return wrap;
    }

    const header = $('<div class="pc-editor-header"></div>');
    header.append($('<h3></h3>').text(prompt.name ?? identifier));
    const actions = $('<div class="pc-editor-actions"></div>');

    const prevSession = ctx.sessionEdits.get(bufferKey(ctx.name, identifier));
    const current = prevSession ? { ...capturePromptFields(prompt), ...prevSession.edited } : undefined;
    const form = buildPromptEditForm(preset, identifier, current);

    const saveBtn = $('<button class="pc-btn-icon pc-btn-icon-primary" title="' + L('Save') + '"></button>')
        .append($('<i class="fa-solid fa-save"></i>'))
        .append(' ' + L('Save'));
    const cancelBtn = $('<button class="pc-btn-icon" title="' + L('Cancel') + '"></button>')
        .append($('<i class="fa-solid fa-times"></i>'))
        .append(' ' + L('Cancel'));

    saveBtn.on('click', () => {
        if (ctx.listLocked) return;
        const editedFields = form.collectFields();
        if (editedFields) {
            const key = bufferKey(ctx.name, identifier);
            // F2：clear 后重新编辑视为覆盖「清除」意图
            ctx.pendingClears.delete(key);
            const session = ctx.sessionEdits.get(key);
            const initial = session?.initial ?? capturePromptFields(prompt);
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
    const row = ctx.dialog.find(`.pc-prompt-card[data-identifier="${cssEscape(identifier)}"]`);
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

    const toggle = row.find('.pc-btn-toggle');
    if (toggle.length) {
        toggle.toggleClass('on', enabled).toggleClass('off', !enabled);
        toggle.html(enabled ? '<i class="fa-solid fa-toggle-on"></i>' : '<i class="fa-solid fa-toggle-off"></i>');
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
    row.toggleClass('dirty', ctx.sessionEdits.has(key) || ctx.pendingToggles.has(key) || ctx.pendingClears.has(key) || ctx.reorderedIds.has(identifier));
    row.toggleClass('persistent', !!view?.hasPersistentDiff);
}

/** staged 计数 + commit 按钮禁用态。 */
export function refreshCounts(ctx: EditorContext, snapshot?: EditorSnapshot): void {
    const n = stagedItems(ctx, snapshot).length;
    ctx.dialog.find('.pc-btn-view-staged .pc-staged-count').text(`(${n})`);
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
    // 挂载/未挂载分组：unused 收进折叠区（模板各渲染一段）
    const entries = snapshot.entries.filter((e) => e.mounted);
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
            items: '.pc-prompt-card',
            placeholder: 'pc-sortable-placeholder',
            start: () => listEl.addClass('sorting'),
            stop: () => listEl.removeClass('sorting'),
            update: () => { void onReorder(ctx, listEl); },
        });
    }
}

/** 拖拽重排：读 DOM 顺序 → 纯计算 → 更新脏标记 + 落盘。 */
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

    const preset = openai_settings[ctx.idx] as Preset;
    const orderList = findOrderList(preset, resolvePromptOrderTarget());
    if (!orderList) return;
    orderList.order = result.order;
    try {
        await saveMeta(ctx.name, ctx.idx, readMeta(preset));
    } catch (err) {
        console.error('Reorder save failed', err);
        toastr.error(L('Failed to save preset metadata'));
        return;
    }
    ctx.refreshActivePresetUI(ctx.name);
}
