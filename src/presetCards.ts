import { renderExtensionTemplateAsync } from '@sillytavern/scripts/extensions';
import { openai_settings, openai_setting_names } from '@sillytavern/scripts/openai';
import { POPUP_TYPE, callGenericPopup } from '@sillytavern/scripts/popup';
import { EXTENSION_NAME } from './constants.js';
import { L } from './i18n.js';
import { readMeta, saveMeta, type Preset } from './meta.js';
import { migrateLegacyV2Profiles } from './presetSnapshot.js';
import { buildPresetList, getCardsTemplateContext } from './presetList.js';
import { applyCachedBackgrounds } from './cache.js';
import { createCardsContext } from './presetCardsContext.js';
import { bindCardsHandlers } from './presetCardsHandlers.js';

/** 打开面板时迁移全部 v2 profile 到 v3（落盘）。迁移后父子关系可正确展示。 */
async function migrateAllV2Profiles(): Promise<void> {
    for (const name of Object.keys(openai_setting_names)) {
        const idx = openai_setting_names[name];
        const preset = openai_settings[idx] as Preset | undefined;
        if (!preset) continue;
        const meta = readMeta(preset);
        if (migrateLegacyV2Profiles(meta)) {
            try {
                await saveMeta(name, idx, meta);
            } catch (err) {
                console.error(`Migrate v2 profiles failed for ${name}`, err);
            }
        }
    }
}

/** 打开 preset-cards 卡片页弹窗。
 * 结构：先迁移 v2 profile → createCardsContext 初始化共享状态 → bindCardsHandlers 绑定事件 → 初始 UI → Popup 展示。 */
export async function openPresetCards(): Promise<void> {
    await migrateAllV2Profiles();

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
