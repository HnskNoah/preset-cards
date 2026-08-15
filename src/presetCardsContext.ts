import type { PromptEditBuffer } from './presetBuffers.js';
import type { PresetStore } from './core/store/PresetStore.js';

/** preset-cards 卡片页弹窗的共享状态（替代巨型函数裸闭包捕获）。 */
export interface CardsContext {
    // DOM（元素身份必须稳定，render 只 html() 重建内容）
    dialog: JQuery<HTMLElement>;
    // 浏览态 store（P3：搜索/批选/激活的单一来源）
    presetStore: PresetStore;
    // 会话可变状态
    presets: import('./presetList.js').PresetCardModel[];
    isBatchMode: boolean;
    batchSelectedCards: Set<string>;
    isConciseMode: boolean;
    /** 本次打开期间的值编辑记录：identifier → { 编辑前字段, 编辑后字段（累积目标值） } */
    sessionEdits: Map<string, PromptEditBuffer>;
    /** 本次打开期间的开关切换缓冲：identifier → 本次会话目标 enabled */
    pendingToggles: Map<string, boolean>;
    /** concise 长按计时器 */
    pressTimer: number | undefined;
}

/** 创建卡片页上下文：完成全部会话状态初始化。 */
export function createCardsContext(
    dialog: JQuery<HTMLElement>,
    presets: import('./presetList.js').PresetCardModel[],
    presetStore: PresetStore,
): CardsContext {
    return {
        dialog,
        presetStore,
        presets,
        isBatchMode: false,
        batchSelectedCards: new Set<string>(),
        isConciseMode: localStorage.getItem('preset_cards_concise') === 'true',
        sessionEdits: new Map<string, PromptEditBuffer>(),
        pendingToggles: new Map<string, boolean>(),
        pressTimer: undefined,
    };
}
