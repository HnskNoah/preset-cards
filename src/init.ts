import { t } from '@sillytavern/scripts/i18n';
import { SlashCommand } from '@sillytavern/scripts/slash-commands/SlashCommand';
import { SlashCommandParser } from '@sillytavern/scripts/slash-commands/SlashCommandParser';
import { openPresetCards } from './presetCards.js';
import { initActiveProfile } from './activeProfile.js';
import { applyProfileToPresetByName } from './presetCardsState.js';

export function refresh(): void {
    location.reload();
}

export function init(): void {
    initActiveProfile();

    // 对外入口：供其它扩展（如 ST-Quicker-Api 便捷方案）加载 preset-cards 的 profile
    (globalThis as Record<string, any>).presetCards = {
        loadProfile: applyProfileToPresetByName,
    };

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
