import type { applyProfileToPresetByName, getPresetProfiles, listPresetsWithProfiles, onProfileChanged, offProfileChanged, ProfileChangedListener } from './presetCardsState.js';
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
    /** 退订 profile 加载事件。 */
    offProfileChanged: typeof offProfileChanged;
    /** 插件与接口版本信息，供第三方判断能力与兼容性。 */
    getInfo: () => {
        /** 扩展名，恒为 'preset-cards'。 */
        name: string;
        /** 插件版本（来自 package.json）。 */
        version: string;
        /** 接口版本：接口有破坏性变更时递增。 */
        apiVersion: number;
    };
}

export type { ProfileChangedListener } from './presetCardsState.js';

declare global {
    interface Window {
        /** preset-cards 提供的第三方集成入口。 */
        presetCards: PresetCardsApi;
    }
}
