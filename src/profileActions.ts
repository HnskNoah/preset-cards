// profile 级纯数据变换：派生构造与级联删除的纯计算。
// 不接触 dialog/DOM；事件 handler 调用后自行持久化与刷新 UI。

import { isPromptDeltaProfile, newProfileId } from './meta.js';
import type { PresetMeta, PromptBaseProfile, PromptDeltaChange, PromptDeltaProfile } from './meta.js';

// 派生新 delta profile 的纯数据构造：「保存为子配置」与「从 base 派生」共用。
// changes 为空数组表示与上级 profile 完全相同的初始 delta，后续通过「覆盖」更新差异。
export function buildDerivedProfile(
    parent: PromptBaseProfile | PromptDeltaProfile,
    name: string,
    changes: PromptDeltaChange[] = [],
): PromptDeltaProfile {
    return { formatVersion: 3, kind: 'prompt_delta', id: newProfileId(), name, baseId: parent.id, changes };
}

// 递归收集所有派生后代（含多层 delta 链）：id → 其后代 id 列表。
// visited 防环：损坏/导入成环数据（delta baseId 指回自身或互相引用）时不致死循环。
export function collectDescendantProfileIds(meta: PresetMeta, rootId: string): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const queue = [String(rootId)];
    while (queue.length > 0) {
        const current = queue.shift() as string;
        if (visited.has(current)) continue;
        visited.add(current);
        for (const p of meta.profiles) {
            if (isPromptDeltaProfile(p) && String(p.baseId) === current) {
                result.push(String(p.id));
                queue.push(String(p.id));
            }
        }
    }
    return result;
}
