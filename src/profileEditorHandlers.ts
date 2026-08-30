import { oai_settings, openai_settings } from '@sillytavern/scripts/openai';
import { POPUP_TYPE, callGenericPopup, Popup } from '@sillytavern/scripts/popup';
import { L } from './i18n.js';
import { isPromptBaseProfile, isPromptDeltaProfile, persistMetaTransaction, readMeta } from './meta.js';
import type { Preset, PromptFields } from './meta.js';
import { bufferKey } from './presetBuffers.js';
import type { PromptEditBuffer } from './presetBuffers.js';
import { findPromptInPreset } from './promptToggle.js';
import { chooseProfileSaveTarget } from './importExport.js';
import { applyBufferedAndSnapshot, applyUndoState, clearSessionBuffers, commitCreateDelta, commitUpdate, effectiveFieldsFor, insertAtInitialPosition, resolveBaselineEntries, resolveProfileMountedMap, resolveToggleNet, resetProfileToParent, stagedItems } from './profileEditorState.js';
import { applyLockVisual, applySearch, refreshCounts, refreshEntryRow, renderDialog, renderRightPane, setupSortable } from './profileEditorRender.js';
import { buildProfileSeedOrder, resolveEditorSnapshot, type EditorContext } from './profileEditorContext.js';

/** 提交/reset 后的会话收尾：清缓冲、退出编辑视图、重渲染 + 刷新。
 * advanceBaseline=true（默认）：把基线推进到当前运行时态（此后净零检测/插回/discard 以最近 commit 为基线）。
 * advanceBaseline=false：仅当源 profile 持久态未变化（如 create-delta，挂载只进新 delta）时使用，
 *   sessionOrder 回到打开时快照（单向数据流：编辑期从未改过预设的 prompt_order，无需还原）。 */
async function finalizeEditorSession(ctx: EditorContext, advanceBaseline = true): Promise<void> {
    clearSessionBuffers(ctx);
    ctx.reorderedIds.clear();
    if (advanceBaseline) {
        // 基线推进：commit 后以 profile 最新解析态为新基线（净零检测/插回/discard 共用）。
        // 不读父预设 prompt_order——注册投影流下它与 profile 无关。
        const preset = openai_settings[ctx.idx] as Preset;
        ctx.initialOrder = buildProfileSeedOrder(preset, ctx.profileId);
        ctx.initialOrderIndex = new Map(ctx.initialOrder.map((o, i) => [o.identifier, i]));
    }
    ctx.sessionOrder = ctx.initialOrder.map((o) => ({ ...o }));
    ctx.editTargetId = null;
    ctx.mobileShowRight = false;
    try {
        await renderDialog(ctx);
        await ctx.onGridRefresh();
    } catch (err) {
        // 数据已提交/重置：渲染失败不改变内存与磁盘状态，仅日志（基线已推进，UI 由下次交互自然重建）
        console.error('Finalize editor session render failed', err);
    }
}

/** 绑定全部事件 handler（逻辑全部下沉 state/render 纯函数，本文件仅做 DOM 绑定）。 */
export function bindEditorHandlers(ctx: EditorContext): void {
    ctx.dialog.on('click', '.pc-prompt-card', function (e) {
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

    // 挂载态开关：激活（挂载）/卸载 unused 条目。只改会话 sessionOrder + 标记 pendingMounts（单向数据流），Commit 才写 profile。
    ctx.dialog.on('click', '.pc-btn-toggle.mount', async function (e) {
        e.stopPropagation();
        const snapshot = resolveEditorSnapshot(ctx);
        if (snapshot?.readOnly) return;
        const identifier = String($(this).closest('.pc-prompt-card').data('identifier'));
        const on = $(this).hasClass('on');
        const target = !on; // true = 挂载；false = 卸载

        const preset = openai_settings[ctx.idx] as Preset;

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

        // 确认通过后操作 sessionOrder（单向数据流：编辑期不改预设的 prompt_order；取消时无残留）
        if (target) {
            // 挂载：sessionOrder 中无此条目则按弹窗打开时的相对位置插回（enabled 保持该 prompt 定义层值，mount 不改 enable）
            if (!ctx.sessionOrder.some((o) => o.identifier === identifier)) {
                insertAtInitialPosition(ctx, identifier, prompt?.enabled ?? true);
            }
        } else {
            // 卸载：记录原位置（undo 撤销卸载时插回原位，reorder 可能已改动位置），再从 sessionOrder 移除
            const idx = ctx.sessionOrder.findIndex((o) => o.identifier === identifier);
            ctx.unmountPositions.set(bufferKey(ctx.name, identifier), idx);
            ctx.sessionOrder = ctx.sessionOrder.filter((o) => o.identifier !== identifier);
        }
        // 净零检测：目标 = profile 解析态的挂载态 → 删缓冲（无净变化）；否则记录。
        // （以 profile 解析态为基线，与 commit 的 diff 语义一致；initialOrder 仅作 UI 插回位置基线）
        const mountedMap = snapshot ? resolveProfileMountedMap(snapshot) : new Map<string, boolean>();
        const resolvedMounted = mountedMap.get(identifier) ?? ctx.initialOrder.some((o) => o.identifier === identifier);
        if (target === resolvedMounted) {
            ctx.pendingMounts.delete(bufferKey(ctx.name, identifier));
        } else {
            ctx.pendingMounts.set(bufferKey(ctx.name, identifier), target);
        }

        await renderDialog(ctx);
        refreshCounts(ctx);
    });

    ctx.dialog.on('click', '.pc-btn-toggle', function (e) {
        e.stopPropagation();
        if ($(this).hasClass('mount')) return;
        // 锁定态允许普通开关切换（Commit 保存仍可用），值编辑/挂载/清除/拖拽/重置保持锁定
        const snapshot = resolveEditorSnapshot(ctx);
        if (snapshot?.readOnly) return;
        const toggle = $(this);
        const entry = toggle.closest('.pc-prompt-card');
        const identifier = String(entry.data('identifier'));
        const on = toggle.hasClass('on');
        const target = !on;

        resolveToggleNet(ctx, snapshot, identifier, target);
        // sessionOrder 同步开关目标值（提交快照以 sessionOrder 为准）
        const soEntry = ctx.sessionOrder.find((o) => o.identifier === identifier);
        if (soEntry) soEntry.enabled = target;

        // R9：同一 tick 只解析一次 profile（刷新函数复用 snapshot）
        refreshEntryRow(ctx, identifier, snapshot);
        refreshCounts(ctx, snapshot);
        renderRightPane(ctx, snapshot);
    });

    ctx.dialog.on('click', '.pc-card-clear', function (e) {
        e.stopPropagation();
        const identifier = String($(this).closest('.pc-prompt-card').data('identifier'));
        const key = bufferKey(ctx.name, identifier);
        const snapshot = resolveEditorSnapshot(ctx);
        if (!snapshot) return;
        if (snapshot.readOnly) return;

        // 快照被清除的会话编辑（undo clear 时恢复，见 buildUndoBtn onlyClear 分支）
        const cleared: { session?: PromptEditBuffer; toggle?: boolean } = {};
        const session = ctx.sessionEdits.get(key);
        if (session) cleared.session = session;
        const toggle = ctx.pendingToggles.get(key);
        if (toggle !== undefined) cleared.toggle = toggle;
        if (cleared.session || cleared.toggle !== undefined) ctx.clearedEdits.set(key, cleared);

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
                const profileToRename = snapshot.profile;
                const meta = resolveEditorSnapshot(ctx)?.meta ?? snapshot.meta;
                // 事务：副本上重命名，持久化成功后写回；失败时内存未变（无需回滚）
                const ok = await persistMetaTransaction(meta, (m) => ({
                    ...m,
                    profiles: m.profiles.map((p) => p === profileToRename ? { ...p, name: newName } : p),
                }), ctx.name, ctx.idx);
                if (!ok) {
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
        if (ctx.committing) return; // re-entrancy 守卫
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

        ctx.committing = true;
        try {
            try {
                const result = await resetProfileToParent(ctx);
                if (result !== 'reset') return;
            } catch (err) {
                console.error('Reset failed', err);
                toastr.error(L('Failed to save preset metadata'));
                return;
            }
            await finalizeEditorSession(ctx);
        } finally {
            ctx.committing = false;
        }
    });

    ctx.dialog.on('click', '#pc-btn-commit', async function () {
        if (ctx.committing) return; // re-entrancy 守卫
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

        // create 的名称输入必须先于缓冲应用——用户取消时不得改写运行时状态
        let deltaName: string | null = null;
        if (choice === 'create') {
            deltaName = await Popup.show.input(L('Derived profile name:'), '');
            if (!deltaName) return;
        }

        ctx.committing = true;
        try {
            const preset = openai_settings[ctx.idx] as Preset;
            // 运行时归属：父预设是否为当前活动预设。注册投影流下活动预设是投影记录，
            // 父预设顶层值/order 与编辑态无关——不写回、不采集（运行时刷新由
            // onMetaPersisted → syncPresetRegistrations → refreshProjectionRuntimeIfActive 闭环负责）
            const isParentRuntime = oai_settings.preset_settings_openai === ctx.name;
            // 有效值字段表（出厂 ⊕ profile 解析）：提交快照与编辑预填共用的基线（A2/A4）
            const metaForBaseline = readMeta(preset);
            const effectiveFields = new Map<string, PromptFields>();
            for (const entry of resolveBaselineEntries(ctx)) {
                effectiveFields.set(entry.identifier, effectiveFieldsFor(metaForBaseline, entry, findPromptInPreset(preset, entry.identifier)));
            }
            const snapshotData = applyBufferedAndSnapshot(preset, ctx.name, ctx.sessionEdits, ctx.pendingToggles, ctx.pendingClears, ctx.sessionOrder, effectiveFields);

            try {
                let ok = true;
                if (choice === 'update') {
                    // 写回与顶层采集由 commitUpdate 内部按 isParentRuntime 分流（字段级写回父预设；
                    // 注册投影流不写父预设，运行时刷新走 onMetaPersisted → sync → refreshProjectionRuntimeIfActive）
                    ok = await commitUpdate(ctx, snapshotData, { captureTopLevel: isParentRuntime });
                } else {
                    await commitCreateDelta(ctx, deltaName as string, snapshotData, { captureTopLevel: isParentRuntime });
                    // create-delta：编辑属于新 delta，源 profile 运行时不写（无 prompts 残留）；编辑期也从未改过预设 prompt_order
                }
                if (!ok) return;
            } catch (err) {
                console.error('Commit failed', err);
                toastr.error(L('Failed to save preset metadata'));
                return; // 缓冲保留可重试；运行时从未被写（纯函数快照），无污染
            }

            // update：源 profile 已持久化 → 推进基线（运行时=已提交态），随后刷新活动态（克隆已提交 order）。
            // create-delta：源 profile 未变 → sessionOrder 回到打开时快照，再刷新活动态（预设未被会话污染）。
            if (choice === 'update') {
                ctx.refreshActivePresetUI(ctx.name);
                await finalizeEditorSession(ctx, true);
            } else {
                await finalizeEditorSession(ctx, false);
                ctx.refreshActivePresetUI(ctx.name);
            }
        } finally {
            ctx.committing = false;
        }
    });

    ctx.dialog.on('click', '#pc-btn-close', async function () {
        if (ctx.committing) return; // 提交/重置进行中忽略关闭
        if (stagedItems(ctx).length > 0) {
            const discard = await callGenericPopup(L('You have uncommitted changes. Discard them?'), POPUP_TYPE.CONFIRM);
            if (!discard) return;
            toastr.info(L('Uncommitted changes discarded'));
            // 单向数据流：编辑期从未改过预设的 prompt_order，无需还原，清缓冲即可
            clearSessionBuffers(ctx);
        }
        ctx.popup?.completeCancelled();
    });

    ctx.dialog.on('click', '#pc-btn-lock', function () {
        ctx.listLocked = !ctx.listLocked;
        applyLockVisual(ctx);
        // 锁定态只锁定顺序：仅禁用拖拽，其余编辑/提交保持可用
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
