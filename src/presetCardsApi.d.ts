import type { applyProfileToPresetByName, getPresetProfiles, listPresetsWithProfiles } from './presetCardsState.js';
import type { getActiveProfile } from './activeProfile.js';

/** preset-cards profile 加载完成后的回调参数。 */
export interface PresetCardsProfileChangedListener {
    (ref: { presetName: string; profileId: string }): void;
}

/** preset-cards 对外暴露的集成 API（挂载于 window.presetCards）。 */
export interface PresetCardsApi {
    /** 加载并持久化指定预设下的 profile。成功返回 true。 */
    loadProfile: typeof applyProfileToPresetByName;
    /** 枚举指定预设下的 profile（id + name）。 */
    getProfiles: typeof getPresetProfiles;
    /** 列出所有含 profile 的预设名。 */
    listPresets: typeof listPresetsWithProfiles;
    /** 当前激活的 profile（presetName + profileId）。 */
    getActiveProfile: () => ReturnType<typeof getActiveProfile>;
    /** 订阅 profile 加载事件（loadProfile 成功后触发）。 */
    onProfileChanged: (listener: PresetCardsProfileChangedListener) => void;
}

declare global {
    interface Window {
        /** preset-cards 提供的第三方集成入口。 */
        presetCards: PresetCardsApi;
    }
}
