import { renderExtensionTemplateAsync } from '@sillytavern/scripts/extensions';
import { POPUP_TYPE, callGenericPopup } from '@sillytavern/scripts/popup';
import { EXTENSION_NAME } from './constants.js';
import { L } from './i18n.js';
import { buildPresetList, getCardsTemplateContext } from './presetList.js';
import { applyCachedBackgrounds } from './cache.js';
import { createCardsContext } from './presetCardsContext.js';
import { bindCardsHandlers } from './presetCardsHandlers.js';

/** 打开 preset-cards 卡片页弹窗。 */
export async function openPresetCards(): Promise<void> {
    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'cards', getCardsTemplateContext());
    const dialog = $(html);

    const ctx = createCardsContext(dialog, buildPresetList());
    if (ctx.isConciseMode) {
        dialog.addClass('preset_cards_concise_mode');
        dialog.find('#preset_cards_concise_btn').addClass('active');
    }

    bindCardsHandlers(ctx);

    // 初始 UI：计数、背景图、展开当前激活 profile 的祖先链
    const countEl = dialog.find('#preset_cards_count');
    countEl.text(`${ctx.presets.length} ${L('presets')}`);
    applyCachedBackgrounds(dialog);
    dialog.find('.preset_card_profile_row.active').parents('.preset_card_profile_group').addClass('expanded');

    callGenericPopup(dialog, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
}
