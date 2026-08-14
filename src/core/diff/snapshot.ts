// core/diff snapshot：完整 preset 快照 → 差异集（零 ST 依赖，纯函数）。
// diff 仅用于 v3 兼容导出/压缩，不参与运行时加载。
import type { PresetSnapshot, PromptStateChange } from '../domain/types.js';
import { diffPromptState } from '../../promptState.js';
import { entriesFromSnapshot } from '../codec/snapshotEntries.js';

/** diff 结构对齐 v3 Delta 磁盘形状：changes = 差异集，order = 完整 mounted 顺序（可选，与父一致时省略）。 */
export interface PresetDiff {
    changes: PromptStateChange[];
    order?: string[];
    /** 顶层设置差异（采样/模型等非 prompts/order/extensions 的键；child 有差异的键取 child 值）。 */
    topLevel?: Record<string, unknown>;
}

const NON_TOP_LEVEL_KEYS = new Set(['prompts', 'prompt_order', 'extensions']);

/** 计算 child 相对 parent 的差异集（v3 兼容 prompts 层 + 顶层设置差异）。 */
export function diffSnapshot(parent: PresetSnapshot, child: PresetSnapshot): PresetDiff {
    const parentEntries = entriesFromSnapshot(parent);
    const childEntries = entriesFromSnapshot(child);
    const { changes, order } = diffPromptState(childEntries.entries, parentEntries.entries, childEntries.unusedIds);
    const topLevel = diffTopLevel(parent, child);
    const diff: PresetDiff = { changes };
    if (order !== undefined) diff.order = order;
    if (topLevel !== undefined) diff.topLevel = topLevel;
    return diff;
}

function diffTopLevel(parent: PresetSnapshot, child: PresetSnapshot): Record<string, unknown> | undefined {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(child)) {
        if (NON_TOP_LEVEL_KEYS.has(key)) continue;
        if (!Object.is(value, parent[key])) result[key] = value;
    }
    // 父有、子无的顶层键也算差异（显式删除）
    for (const key of Object.keys(parent)) {
        if (NON_TOP_LEVEL_KEYS.has(key) || key in child) continue;
        result[key] = undefined;
    }
    return Object.keys(result).length > 0 ? result : undefined;
}
