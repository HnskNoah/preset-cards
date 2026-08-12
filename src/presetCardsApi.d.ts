import type { applyProfileToPresetByName, getPresetProfiles, listPresetsWithProfiles, onProfileChanged } from './presetCardsState.js';
import type { getActiveProfile } from './activeProfile.js';

/** preset-cards 对外暴露的集成 API（挂载于 window.presetCards）。 */
export interface PresetCardsApi {
    /** 加载并持久化指定预设下的 profile。成功返回 true（成功时触发 onProfileChanged）。 */
    loadProfile: typeof applyProfileToPresetByName;
    /** 枚举指定预设下的 profile（id + name）。 */
    getProfiles: typeof getPresetProfiles;
    /** 列出所有含 profile 的预设名。 */
    listPresets: typeof listPresetsWithProfiles;
    /** 当前激活的 profile（presetName + profileId）。 */
    getActiveProfile: () => ReturnType<typeof getActiveProfile>;
    /** 订阅 profile 加载事件（任何加载路径成功后触发），返回退订函数。 */
    onProfileChanged: typeof onProfileChanged;
}

declare global {
    interface Window {
        /** preset-cards 提供的第三方集成入口。 */
        presetCards: PresetCardsApi;
    }
}
