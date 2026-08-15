import { t } from '@sillytavern/scripts/i18n';
import { SlashCommand } from '@sillytavern/scripts/slash-commands/SlashCommand';
import { SlashCommandParser } from '@sillytavern/scripts/slash-commands/SlashCommandParser';
import { openPresetCards } from './presetCards.js';
import { getActiveProfile, initActiveProfile } from './activeProfile.js';
import { applyProfileToPresetByName, getPresetProfiles, getProfileModel, listPresetsWithProfiles, onProfileChanged } from './presetCardsState.js';
import { initPresetOrderNormalization } from './fastApply.js';
import { initPresetRegistration } from './presetRegistration.js';
import type { PresetCardsApi } from './types/presetCardsApi.js';

export function refresh(): void {
    location.reload();
}

/** 外部扩展集成入口（挂 window.presetCards）：供 ST-Quicker-Api 等便捷方案加载/查询 profile。 */
export function exposePresetCardsApi(): PresetCardsApi {
    return {
        loadProfile: applyProfileToPresetByName,
        getProfiles: getPresetProfiles,
        getProfileModel,
        listPresets: listPresetsWithProfiles,
        getActiveProfile: () => getActiveProfile(),
        onProfileChanged,
    };
}

export function init(): void {
    initActiveProfile();
    initPresetOrderNormalization();
    initPresetRegistration();

    // 对外入口：供其它扩展（如 ST-Quicker-Api 便捷方案）加载 preset-cards 的 profile
    window.presetCards = exposePresetCardsApi();

    const buttonHtml = `
        <div id="preset_cards_button" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-grip extensionsMenuExtensionButton"></div>` +
        t`Preset Cards` +
        '</div>';
    $('#token_counter_wand_container').append(buttonHtml);
    $('#preset_cards_button').on('click', openPresetCards);

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'presetcards',
        callback: async () => {
            await openPresetCards();
            return '';
        },
        helpString: 'Opens the preset cards view for Chat Completion presets.',
    }));
}
