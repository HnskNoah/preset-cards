import { POPUP_TYPE, Popup, callGenericPopup } from '@sillytavern/scripts/popup';
import { openai_settings } from '@sillytavern/scripts/openai';
import { L } from './i18n.js';
import { createEditorContext, type ProfileEditorDeps } from './profileEditorContext.js';
import { bindEditorHandlers } from './profileEditorHandlers.js';
import { renderDialog } from './profileEditorRender.js';
import { clearSessionBuffers, seedPresetDriftIntoBuffers, stagedItems } from './profileEditorState.js';
import { getProfile, readMeta } from './meta.js';
import { resolveProfilePrompts } from './promptToggle.js';
import { createEditorStore } from './core/store/EditorStore.js';
import { entriesToSnapshot } from './core/codec/snapshotEntries.js';

export type { ProfileEditorDeps };

/**
 * 打开 profile 编辑器弹窗（pcmanager 式左右栏）。
 * 结构：createEditorContext 初始化共享状态 → bindEditorHandlers 绑定事件 → renderDialog 渲染 → Popup 展示。
 * 关闭弹窗即结束本次编辑会话：缓冲仅存内存，重开（点击 profile = 重新加载）会覆盖 preset 并清空缓冲。
 */
export async function openProfileEditorPopup(
    deps: ProfileEditorDeps,
    name: string,
    idx: number,
    profileId: string,
): Promise<void> {
    const ctx = createEditorContext(deps, name, idx, profileId);
    // 漂移种子化：字段级流下把父预设相对 profile 的原生编辑预填为可见 staged 项（可逐项撤销/随 commit 固化）
    seedPresetDriftIntoBuffers(ctx);
    // P4：编辑器会话拥有 EditorStore（初始快照 = 当前 profile 的 v4 快照，staged 空）
    ctx.editorStore = createEditorStore(initialEditorState(ctx, profileId));
    bindEditorHandlers(ctx);

    await renderDialog(ctx);

    ctx.popup = new Popup(ctx.dialog, POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: false,
        transparent: true,
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });

    await ctx.popup.show();

    // R2/F6：关闭弹窗即结束本次编辑会话。按钮退出已先确认并清缓冲；
    // 此处兜底 Escape/其他关闭路径仍有未提交改动时提示丢弃。用户选择保留（取消）时不清缓冲——
    // 缓冲与卡片页共享，保留改动可供后续「Save Base Profile」落盘。
    // 单向数据流：编辑期从未改过预设的 prompt_order，丢弃时无需还原，清缓冲即可。
    if (stagedItems(ctx).length > 0) {
        const discard = await callGenericPopup(L('You have uncommitted changes. Discard them?'), POPUP_TYPE.CONFIRM);
        if (discard) {
            toastr.info(L('Uncommitted changes discarded'));
            clearSessionBuffers(ctx);
        }
    }
}

/** 编辑器初始状态：当前 profile 的 v4 快照（全量解析）为基线，staged 空。 */
function initialEditorState(
    ctx: ReturnType<typeof createEditorContext>,
    profileId: string,
): Parameters<typeof createEditorStore>[0] {
    const preset = openai_settings[ctx.idx] as any;
    const meta = readMeta(preset);
    const profile = getProfile(meta, profileId);
    const entries = profile ? resolveProfilePrompts(profile, meta.profiles as any) : [];
    return {
        nodeId: profileId,
        snapshot: entriesToSnapshot(entries),
        staged: { changes: [] },
        undoStack: [],
        redoStack: [],
        dirty: false,
        readOnly: false,
    };
}
