import { POPUP_TYPE, Popup, callGenericPopup } from '@sillytavern/scripts/popup';
import { L } from './i18n.js';
import { createEditorContext, type ProfileEditorDeps } from './profileEditorContext.js';
import { bindEditorHandlers } from './profileEditorHandlers.js';
import { renderDialog } from './profileEditorRender.js';
import { clearSessionBuffers, stagedItems } from './profileEditorState.js';

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
