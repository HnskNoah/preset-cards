/** preset-cards 对外暴露的集成 API（挂载于 window.presetCards）。
 *  第三方扩展可直接引用本声明文件获得类型校验，无需依赖 preset-cards 源码树。 */
export interface PresetCardsApi {
    /** 加载并持久化指定预设下的 profile。成功返回 true（成功时触发 onProfileChanged）。 */
    loadProfile(presetName: string, profileId: string): Promise<boolean>;
    /** 枚举指定预设下的非 archive profile（id + name）。 */
    getProfiles(presetName: string): { id: string; name: string }[];
    /** 列出所有含 profile 的预设名。 */
    listPresets(): string[];
    /** 当前激活的 profile（presetName + profileId）。 */
    getActiveProfile(): { presetName: string; profileId: string } | undefined;
    /** 订阅 profile 加载事件（任何加载路径成功后触发），返回退订函数。 */
    onProfileChanged(listener: (ref: { presetName: string; profileId: string }) => void): () => void;
}

declare global {
    interface Window {
        /** preset-cards 提供的第三方集成入口。 */
        presetCards: PresetCardsApi;
    }
}