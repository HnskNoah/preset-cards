import { oai_settings, openai_settings } from '@sillytavern/scripts/openai';
import { POPUP_TYPE, callGenericPopup, Popup } from '@sillytavern/scripts/popup';
import { L } from './i18n.js';
import { isPromptBaseProfile, isPromptDeltaProfile, saveMeta } from './meta.js';
import type { Preset } from './meta.js';
import { applyBufferedEdits, bufferKey } from './presetBuffers.js';
import { findOrderList, findPromptInPreset, resolvePromptOrderTarget } from './promptToggle.js';
import { buildProfileOrderCtx } from './presetList.js';
import { chooseProfileSaveTarget } from './importExport.js';
import { applyBufferedAndSnapshot, applyUndoState, clearSessionBuffers, commitCreateDelta, commitUpdate, insertAtInitialPosition, resolveToggleNet, resetProfileToParent, restoreOrderIfUncommitted, stagedItems } from './profileEditorState.js';
import { applyLockVisual, applySearch, refreshCounts, refreshEntryRow, renderDialog, renderRightPane, setupSortable } from './profileEditorRender.js';
import { resolveEditorSnapshot, type EditorContext } from './profileEditorContext.js';

/** 提交/reset 后的会话收尾：清缓冲、退出编辑视图、重渲染弹窗 + 刷新卡片网格。 */
/** 提交/reset 后的会话收尾：清缓冲、退出编辑视图、重渲染 + 刷新。
 * advanceBaseline=true（默认）：把基线推进到当前运行时态（此后净零检测/插回/discard 以最近 commit 为基线）。
 * advanceBaseline=false：仅当源 profile 持久态未变化（如 create-delta，挂载只进新 delta）时使用，基线维持打开时快照。
 * restoreRuntime：清缓冲前先把运行时 order 还原到基线（create-delta 专用——挂载改动只进新 delta，
 *   源 profile 未持久化，运行时残留会随后续 saveMeta 静默落盘）。 */
async function finalizeEditorSession(ctx: EditorContext, advanceBaseline = true, restoreRuntime = false): Promise<void> {
    if (restoreRuntime) {
        restoreOrderIfUncommitted(ctx);
    }
    clearSessionBuffers(ctx);
    ctx.reorderedIds.clear();
    if (advanceBaseline) {
        // 基线推进：commit 后以当前运行时 order 作为新 initialOrder（净零检测、insertAtInitialPosition、restoreOrderIfUncommitted 共用）
        const preset = openai_settings[ctx.idx] as Preset;
        const list = findOrderList(preset, resolvePromptOrderTarget());
        ctx.initialOrder = Array.isArray(list?.order)
            ? list.order
                .filter((o: any) => o && typeof o.identifier === 'string')
                .map((o: any) => ({ identifier: o.identifier, enabled: o.enabled === true }))
            : [];
        ctx.initialOrderIndex = buildProfileOrderCtx(preset, oai_settings.preset_settings_openai === ctx.name).orderIndex;
    }
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

    // 挂载态开关：激活（挂载）/卸载 unused 条目。改内存 prompt_order + 标记 pendingMounts，Commit 才写 profile。
    ctx.dialog.on('click', '.pc-btn-toggle.mount', async function (e) {
        e.stopPropagation();
        if (ctx.listLocked) return;
        const snapshot = resolveEditorSnapshot(ctx);
        if (snapshot?.readOnly) return;
        const identifier = String($(this).closest('.pc-prompt-card').data('identifier'));
        const on = $(this).hasClass('on');
        const target = !on; // true = 挂载；false = 卸载

        const preset = openai_settings[ctx.idx] as Preset;
        const targetId = resolvePromptOrderTarget();

        // 激活（挂载）前警告：unused prompt 可能并非设计为可激活项，激活后可用性不作保证。
        // system_prompt / marker 用专门确认文案（AGENTS 约定）；按钮「激活 / 取消」。
        const prompt = findPromptInPreset(preset, identifier);
        if (target) {
            const isSpecial = !!(prompt?.system_prompt || prompt?.marker);
            const confirmText = isSpecial
                ? L('Mount this system prompt / marker?')
                : `${L('Activate this unused prompt?')}\n${L('This prompt is in the unused list. It may not be intended for activation and its usability after activation is not guaranteed.')}`;
            const ok = await callGenericPopup(confirmText, POPUP_TYPE.CONFIRM, '', { okButton: L('Activate'), cancelButton: L('Cancel') });
            if (!ok) return;
        } else if (prompt?.system_prompt || prompt?.marker) {
            // 卸载 system_prompt / marker 仍需确认（AGENTS 约定）
            const ok = await callGenericPopup(L('Unmount this system prompt / marker?'), POPUP_TYPE.CONFIRM);
            if (!ok) return;
        }

        // 确认通过后才创建/确保目标 order 列表（取消时不得残留空列表）
        let list = findOrderList(preset, targetId);
        if (!list) {
            if (!Array.isArray(preset.prompt_order)) preset.prompt_order = [];
            list = { character_id: targetId, order: [] };
            preset.prompt_order.push(list);
        }
        if (!Array.isArray(list.order)) list.order = [];

        if (target) {
            // 挂载：若 order 里无此条目则按弹窗打开时的相对位置插回（enabled 保持该 prompt 定义层值，mount 不改 enable）
            if (!list.order.some((o: any) => o?.identifier === identifier)) {
                insertAtInitialPosition(ctx, list, identifier, prompt?.enabled ?? true);
            }
        } else {
            // 卸载：记录原位置（undo 撤销卸载时插回原位，reorder 可能已改动位置），再从 order 移除
            const idx = list.order.findIndex((o: any) => o?.identifier === identifier);
            ctx.unmountPositions.set(bufferKey(ctx.name, identifier), idx);
            list.order = list.order.filter((o: any) => o?.identifier !== identifier);
        }
        // 净零检测：目标 = 弹窗打开时快照的挂载态 → 删缓冲（无净变化）；否则记录
        const initialMounted = ctx.initialOrder.some((o) => o.identifier === identifier);
        if (target === initialMounted) {
            ctx.pendingMounts.delete(bufferKey(ctx.name, identifier));
        } else {
            ctx.pendingMounts.set(bufferKey(ctx.name, identifier), target);
        }

        await renderDialog(ctx);
        refreshCounts(ctx);
    });

    ctx.dialog.on('click', '.pc-btn-toggle', function (e) {
        e.stopPropagation();
        if (ctx.listLocked) return; // 锁定列表时禁止切换（与 mount 开关一致）
        if ($(this).hasClass('mount')) return;
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
                const oldName = currentName; // 回滚用旧名（shared profile 对象，改名直接作用到 preset 内存）
                snapshot.profile.name = newName;
                const meta = resolveEditorSnapshot(ctx)?.meta ?? snapshot.meta;
                try {
                    // POST 前先改 name → 保存内容含新名（doSaveMeta 引用同一 profiles 数组）
                    await saveMeta(ctx.name, ctx.idx, meta);
                } catch (err) {
                    // 失败回滚内存 name，避免内存/磁盘分裂；UI 重建为旧名
                    snapshot.profile.name = oldName;
                    console.error('Rename failed', err);
                    toastr.error(L('Failed to save preset metadata'));
                    await renderDialog(ctx);
                    return; // 不误报成功
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

        let confirmText = L('Reset this configuration to its parent?');
        if (stagedItems(ctx).length > 0) {
            confirmText += `\n${L('Uncommitted changes will be discarded')}`;
        }
        const confirm = await callGenericPopup(confirmText, POPUP_TYPE.CONFIRM);
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
                if (ok) {
                    // 副作用后置：update 持久化成功后，才把缓冲写进运行时（此时=已提交态，天然一致）
                    applyBufferedEdits(preset, ctx.name, ctx.sessionEdits, ctx.pendingToggles);
                }
            } else {
                await commitCreateDelta(ctx, deltaName as string, snapshotData);
                // create-delta：编辑属于新 delta，源 profile 运行时不写（无 prompts 残留）；挂载/顺序残留由 finalizeEditorSession 还原
            }
            if (!ok) return;
        } catch (err) {
            console.error('Commit failed', err);
            toastr.error(L('Failed to save preset metadata'));
            return; // 缓冲保留可重试；运行时从未被写（纯函数快照），无污染
        }

        // update：源 profile 已持久化 → 推进基线、不还原运行时（副作用已写入=已提交态），随后刷新活动态（克隆已提交 order）。
        // create-delta：源 profile 未变 → 先还原运行时 order（挂载/顺序残留）到基线，再刷新活动态，
        //   否则 refreshActivePresetUI 会把含残留挂载的 order 克隆进 oai_settings（#1，活动面板/落盘被污染）。
        if (choice === 'update') {
            ctx.refreshActivePresetUI(ctx.name);
            await finalizeEditorSession(ctx, true, false);
        } else {
            await finalizeEditorSession(ctx, false, true);
            ctx.refreshActivePresetUI(ctx.name);
        }
    });

    ctx.dialog.on('click', '#pc-btn-close', async function () {
        if (stagedItems(ctx).length > 0) {
            const discard = await callGenericPopup(L('You have uncommitted changes. Discard them?'), POPUP_TYPE.CONFIRM);
            if (!discard) return;
            toastr.info(L('Uncommitted changes discarded'));
            // 未提交的挂载/顺序改动：还原内存 prompt_order 到弹窗打开时
            restoreOrderIfUncommitted(ctx);
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
        // 防抖：连续输入不逐键全量过滤，减少大列表下的 DOM 卡顿
        if (ctx.searchTimer) clearTimeout(ctx.searchTimer);
        ctx.searchTimer = setTimeout(() => {
            ctx.searchTimer = undefined;
            applySearch(ctx);
            setupSortable(ctx); // 搜索中禁用拖拽
        }, 120);
    });

    // 未使用 prompt 折叠区：点击标题展开/收起
    ctx.dialog.on('click', '.pc-unused-toggle', function () {
        const group = $(this).closest('.pc-unused-group');
        const list = group.find('.pc-unused-list');
        const expanded = group.hasClass('expanded');
        group.toggleClass('expanded', !expanded);
        list.toggle(!expanded);
    });
}
