// core/diff snapshot：完整 preset 快照 → 差异集（零 ST 依赖，纯函数）。
// diff 仅用于 v3 兼容导出/压缩，不参与运行时加载。
import type { PresetSnapshot, PromptStateChange } from '../domain/types.js';
import { diffPromptState } from '../../promptState.js';
import { entriesFromSnapshot } from '../codec/snapshotEntries.js';

/** diff 结构对齐 v3 Delta 磁盘形状：changes = 差异集，order = 完整 mounted 顺序（可选，与父一致时省略）。 */
export interface PresetDiff {
    changes: PromptStateChange[];
    order?: string[];
}

/** 计算 child 相对 parent 的差异集（v3 兼容；顶层设置/扩展差异后续切片）。 */
export function diffSnapshot(parent: PresetSnapshot, child: PresetSnapshot): PresetDiff {
    const parentEntries = entriesFromSnapshot(parent);
    const childEntries = entriesFromSnapshot(child);
    const { changes, order } = diffPromptState(childEntries.entries, parentEntries.entries, childEntries.unusedIds);
    return order !== undefined ? { changes, order } : { changes };
}
