import { t } from '@sillytavern/scripts/i18n';
import { SlashCommand } from '@sillytavern/scripts/slash-commands/SlashCommand';
import { SlashCommandParser } from '@sillytavern/scripts/slash-commands/SlashCommandParser';
import { openPresetCards } from './presetCards.js';
import { getActiveProfile, initActiveProfile } from './activeProfile.js';
import { applyProfileToPresetByName, getPresetProfiles, listPresetsWithProfiles } from './presetCardsState.js';

export function refresh(): void {
    location.reload();
}

/** preset-cards 对外 API 的订阅回调（profile 加载完成后触发）。 */
export type PresetCardsProfileChangedListener = (ref: { presetName: string; profileId: string }) => void;

/** 外部扩展集成入口（挂 window.presetCards）：供 ST-Quicker-Api 等便捷方案加载/查询 profile。 */
export function exposePresetCardsApi(): {
    loadProfile: typeof applyProfileToPresetByName;
    getProfiles: typeof getPresetProfiles;
    listPresets: typeof listPresetsWithProfiles;
    getActiveProfile: () => { presetName: string; profileId: string } | undefined;
    onProfileChanged: (listener: PresetCardsProfileChangedListener) => void;
} {
    const listeners = new Set<PresetCardsProfileChangedListener>();
    const loadProfile = async (name: string, profileId: string) => {
        const ok = await applyProfileToPresetByName(name, profileId);
        if (ok) {
            const ref = { presetName: name, profileId };
            for (const listener of listeners) listener(ref);
        }
        return ok;
    };
    return {
        loadProfile,
        getProfiles: getPresetProfiles,
        listPresets: listPresetsWithProfiles,
        getActiveProfile: () => getActiveProfile(),
        onProfileChanged: (listener) => { listeners.add(listener); },
    };
}

export function init(): void {
    initActiveProfile();

    // 对外入口：供其它扩展（如 ST-Quicker-Api 便捷方案）加载 preset-cards 的 profile
    (globalThis as Record<string, any>).presetCards = exposePresetCardsApi();

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
