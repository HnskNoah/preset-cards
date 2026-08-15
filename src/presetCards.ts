import { renderExtensionTemplateAsync } from '@sillytavern/scripts/extensions';
import { POPUP_TYPE, callGenericPopup } from '@sillytavern/scripts/popup';
import { oai_settings } from '@sillytavern/scripts/openai';
import { EXTENSION_NAME } from './constants.js';
import { L } from './i18n.js';
import { buildPresetList, getCardsTemplateContext, type PresetCardModel } from './presetList.js';
import { applyCachedBackgrounds } from './cache.js';
import { createCardsContext } from './presetCardsContext.js';
import { bindCardsHandlers } from './presetCardsHandlers.js';
import { applyNameWrap } from './nameWrap.js';
import { createPresetStore, type PresetEntry } from './core/store/PresetStore.js';
import { refreshActiveCardSelection } from './presetCardsState.js';
import { onActiveProfileChangedBySwitch } from './presetRegistration.js';

/** 打开 preset-cards 卡片页弹窗。 */
export async function openPresetCards(): Promise<void> {
    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'cards', getCardsTemplateContext());
    const dialog = $(html);

    applyNameWrap(dialog);

    const presets = buildPresetList();
    const presetStore = createPresetStore({
        presets: toPresetEntries(presets),
        search: '',
        selectedIds: new Set<string>(),
        activeName: oai_settings.preset_settings_openai,
        isBatchMode: false,
        nodes: [],
    });
    const ctx = createCardsContext(dialog, presets, presetStore);
    if (ctx.isConciseMode) {
        dialog.addClass('preset_cards_concise_mode');
        dialog.find('#preset_cards_concise_btn').addClass('active');
    }

    bindCardsHandlers(ctx);

    // 注册链路：原生切换(PRESET_CHANGED)同步卡片高亮——激活 profile 投影或切回普通预设都刷新选中态
    onActiveProfileChangedBySwitch(() => refreshActiveCardSelection(ctx));

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

/** 完整卡片模型 → 浏览态条目（store 用，UI 渲染仍用完整模型）。 */
function toPresetEntries(presets: PresetCardModel[]): PresetEntry[] {
    return presets.map((p) => ({
        name: p.name,
        profileCount: p.profiles?.length ?? 0,
        isActive: p.isActive,
    }));
}
