import { openai_settings } from '@sillytavern/scripts/openai';
import { POPUP_TYPE, callGenericPopup, Popup } from '@sillytavern/scripts/popup';
import { L } from './i18n.js';
import { isPromptBaseProfile, isPromptDeltaProfile, saveMeta } from './meta.js';
import type { Preset } from './meta.js';
import { bufferKey } from './presetBuffers.js';
import { chooseProfileSaveTarget } from './importExport.js';
import { applyBufferedAndSnapshot, applyUndoState, clearSessionBuffers, commitCreateDelta, commitUpdate, resolveToggleNet, resetProfileToParent, stagedItems } from './profileEditorState.js';
import { applyLockVisual, applySearch, refreshCounts, refreshEntryRow, renderDialog, renderRightPane, setupSortable } from './profileEditorRender.js';
import { resolveEditorSnapshot, type EditorContext } from './profileEditorContext.js';

/** 提交/reset 后的会话收尾：清缓冲、退出编辑视图、重渲染弹窗 + 刷新卡片网格。 */
async function finalizeEditorSession(ctx: EditorContext): Promise<void> {
    clearSessionBuffers(ctx);
    ctx.reorderedIds.clear();
    ctx.editTargetId = null;
    ctx.mobileShowRight = false;
    await renderDialog(ctx);
    await ctx.onGridRefresh();
}

/** 绑定全部事件 handler（逻辑全部下沉 state/render 纯函数，本文件仅做 DOM 绑定）。 */
export function bindEditorHandlers(ctx: EditorContext): void {
    ctx.dialog.on('click', '.pc-prompt-card', function (e) {
        if (ctx.listLocked) return;
        const snapshot = resolveEditorSnapshot(ctx);
        if (snapshot?.readOnly) return;
        if ($(e.target).closest('.pc-drag-handle, .pc-card-clear, .pc-btn-toggle, button').length) return;
        const identifier = String($(this).data('identifier'));
        const view = snapshot?.entries.find((x) => x.identifier === identifier);
        if (!view?.editable) return; // system_prompt / marker 不渲染编辑
        ctx.editTargetId = identifier;
        ctx.mobileShowRight = true;
        renderRightPane(ctx, snapshot);
    });

    ctx.dialog.on('click', '.pc-btn-toggle', function (e) {
        e.stopPropagation();
        const snapshot = resolveEditorSnapshot(ctx);
        if (snapshot?.readOnly) return;
        const toggle = $(this);
        const entry = toggle.closest('.pc-prompt-card');
        const identifier = String(entry.data('identifier'));
        const on = toggle.hasClass('on');
        const target = !on;

        resolveToggleNet(ctx, snapshot, identifier, target);

        // R9：同一 tick 只解析一次 profile（刷新函数复用 snapshot）
        refreshEntryRow(ctx, identifier, snapshot);
        refreshCounts(ctx, snapshot);
        renderRightPane(ctx, snapshot);
    });

    ctx.dialog.on('click', '.pc-card-clear', function (e) {
        e.stopPropagation();
        if (ctx.listLocked) return;
        const identifier = String($(this).closest('.pc-prompt-card').data('identifier'));
        const key = bufferKey(ctx.name, identifier);
        const snapshot = resolveEditorSnapshot(ctx);
        if (!snapshot) return;
        if (snapshot.readOnly) return;

        // R1：不再直接改 profile 内存快照（否则会被拖拽 saveMeta 静默落盘、且无法进入 staged diff）；
        // clear 记入 pendingClears 缓冲，Commit 时统一删除快照 fields。
        // 同时撤销会话值缓冲（full undo）：还原运行时至会话初始值并镜像活动预设。
        applyUndoState(ctx, key, identifier);
        ctx.pendingClears.set(key, true);

        // F8：复用已取出的 snapshot，避免重复全量解析
        renderRightPane(ctx, snapshot);
        refreshEntryRow(ctx, identifier, snapshot);
        refreshCounts(ctx, snapshot);
    });

    ctx.dialog.on('click', '.pc-btn-view-staged', function () {
        ctx.editTargetId = null;
        ctx.mobileShowRight = true;
        renderRightPane(ctx);
    });

    // 手机端暂存视图：隐藏搜索栏，返回按钮退回列表视图
    ctx.dialog.on('click', '#pc-btn-back', function () {
        ctx.editTargetId = null;
        ctx.mobileShowRight = false;
        renderRightPane(ctx);
    });

    // 重命名当前 profile：面包屑末项（当前节点）变行内 input，Enter/blur 提交 → saveMeta + 刷新。
    ctx.dialog.on('click', '#pc-btn-rename', function () {
        const snapshot = resolveEditorSnapshot(ctx);
        if (!snapshot) return;
        if (snapshot.readOnly) return;

        const currentItem = ctx.dialog.find('.pc-breadcrumb-item.pc-breadcrumb-current');
        if (currentItem.length === 0) return;

        const currentName = snapshot.profile.name;
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
                snapshot.profile.name = newName;
                const meta = resolveEditorSnapshot(ctx)?.meta ?? snapshot.meta;
                try {
                    await saveMeta(ctx.name, ctx.idx, meta);
                } catch (err) {
                    console.error('Rename failed', err);
                    toastr.error(L('Failed to save preset metadata'));
                }
                toastr.success(`${L('Rename')}: ${newName}`);
                await renderDialog(ctx);
                await ctx.onGridRefresh();
            } else {
                await renderDialog(ctx);
            }
        });
    });

    // ---- Reset to parent（delta → 上级；base → 隐藏默认）----
    ctx.dialog.on('click', '#pc-btn-reset', async function () {
        const snapshot = resolveEditorSnapshot(ctx);
        if (!snapshot) return;
        if (snapshot.readOnly) return;
        if (!isPromptBaseProfile(snapshot.profile) && !isPromptDeltaProfile(snapshot.profile)) {
            toastr.warning(L('This profile type cannot be reset'));
            return;
        }

        const confirm = await callGenericPopup(L('Reset this configuration to its parent?'), POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        try {
            const result = await resetProfileToParent(ctx);
            if (result !== 'reset') return;
        } catch (err) {
            console.error('Reset failed', err);
            toastr.error(L('Failed to save preset metadata'));
            return;
        }
        await finalizeEditorSession(ctx);
    });

    ctx.dialog.on('click', '#pc-btn-commit', async function () {
        const snapshot = resolveEditorSnapshot(ctx);
        if (!snapshot) return;
        if (snapshot.readOnly) return;
        if (stagedItems(ctx).length === 0) return;
        if (!isPromptBaseProfile(snapshot.profile) && !isPromptDeltaProfile(snapshot.profile)) {
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

        const preset = openai_settings[ctx.idx] as Preset;
        const snapshotData = applyBufferedAndSnapshot(preset, ctx.name, ctx.sessionEdits, ctx.pendingToggles, ctx.pendingClears);

        try {
            let ok = true;
            if (choice === 'update') {
                ok = await commitUpdate(ctx, snapshotData);
            } else {
                await commitCreateDelta(ctx, deltaName as string, snapshotData);
            }
            if (!ok) return;
        } catch (err) {
            console.error('Commit failed', err);
            toastr.error(L('Failed to save preset metadata'));
            return; // 保留缓冲，用户可重试
        }

        ctx.refreshActivePresetUI(ctx.name);
        await finalizeEditorSession(ctx);
    });

    ctx.dialog.on('click', '#pc-btn-close', async function () {
        if (stagedItems(ctx).length > 0) {
            const discard = await callGenericPopup(L('You have uncommitted changes. Discard them?'), POPUP_TYPE.CONFIRM);
            if (!discard) return;
            toastr.info(L('Uncommitted changes discarded'));
            clearSessionBuffers(ctx);
        }
        ctx.popup?.completeCancelled();
    });

    ctx.dialog.on('click', '#pc-btn-lock', function () {
        ctx.listLocked = !ctx.listLocked;
        applyLockVisual(ctx);
        // 锁定时退出当前编辑视图（编辑表单 Save/Cancel 不再可用）并禁用拖拽
        if (ctx.listLocked) {
            ctx.editTargetId = null;
            ctx.mobileShowRight = false;
            renderRightPane(ctx);
        }
        setupSortable(ctx);
    });

    ctx.dialog.on('input', '#pc-search-input', function () {
        ctx.searchQuery = String($(this).val() ?? '');
        applySearch(ctx);
        setupSortable(ctx); // 搜索中禁用拖拽
    });
}
