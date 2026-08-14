// profile 级纯数据变换：派生构造与级联删除的纯计算。
// 不接触 dialog/DOM；事件 handler 调用后自行持久化与刷新 UI。

import { getProfile, isPromptDeltaProfile, newProfileId } from './meta.js';
import type { PresetMeta, PresetProfile, PromptBaseProfile, PromptDeltaChange, PromptDeltaProfile, PromptModel, PromptProfileEntry, PromptSampling } from './meta.js';

/** fv3 base 工厂：统一可选字段拼接（unusedIds/sampling/extra/model）。 */
export function makeBaseProfile(p: {
    id: string;
    name: string;
    prompts: PromptProfileEntry[];
    unusedIds?: string[];
    sampling?: PromptSampling;
    extra?: Record<string, any>;
    model?: PromptModel;
}): PromptBaseProfile {
    return {
        formatVersion: 3,
        kind: 'prompt_base',
        id: p.id,
        name: p.name,
        prompts: p.prompts,
        ...(p.unusedIds ? { unusedIds: p.unusedIds } : {}),
        ...(p.sampling ? { sampling: p.sampling } : {}),
        ...(p.extra ? { extra: p.extra } : {}),
        ...(p.model ? { model: p.model } : {}),
    };
}

/** fv3 delta 工厂：统一可选字段拼接（order/sampling/extra/model）。 */
export function makeDeltaProfile(p: {
    id: string;
    name: string;
    baseId: string;
    changes: PromptDeltaChange[];
    order?: string[];
    sampling?: PromptSampling;
    extra?: Record<string, any>;
    model?: PromptModel;
}): PromptDeltaProfile {
    return {
        formatVersion: 3,
        kind: 'prompt_delta',
        id: p.id,
        name: p.name,
        baseId: p.baseId,
        changes: p.changes,
        ...(p.order ? { order: p.order } : {}),
        ...(p.sampling ? { sampling: p.sampling } : {}),
        ...(p.extra ? { extra: p.extra } : {}),
        ...(p.model ? { model: p.model } : {}),
    };
}

// 派生新 delta profile 的纯数据构造：「保存为子配置」与「从 base 派生」共用。
// changes 为空数组表示与上级 profile 完全相同的初始 delta，后续通过「覆盖」更新差异。
// order 可选：仅当新 delta 的挂载顺序与父链不同时传入（顺序差异走 order，纯顺序语义）。
export function buildDerivedProfile(
    parent: PromptBaseProfile | PromptDeltaProfile,
    name: string,
    changes: PromptDeltaChange[] = [],
    sampling?: PromptSampling,
    order?: string[],
    model?: PromptModel,
    extra?: Record<string, any>,
): PromptDeltaProfile {
    return makeDeltaProfile({
        id: newProfileId(),
        name,
        baseId: parent.id,
        changes,
        ...(sampling ? { sampling } : {}),
        ...(order ? { order } : {}),
        ...(model ? { model } : {}),
        ...(extra ? { extra } : {}),
    });
}

// 判断 profile 是否为导入存档 base（只读隐藏）。v1/v2 迁移已移除，始终返回 false 保留接口兼容。
export function isArchiveProfile(_profile: PromptBaseProfile | PromptDeltaProfile): boolean {
    return false;
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

// 收集 profile 的完整父链 id（含自身）：沿 baseId 向上直到根（base 或父缺失/非 base/delta）。
// 顺序为从自身到根，供「单 profile 导出连带父链」使用；visited 防环。
export function collectAncestorProfileIds(meta: PresetMeta, profileId: string): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    let current: PresetProfile | undefined = getProfile(meta, profileId);
    while (current && !visited.has(String(current.id))) {
        visited.add(String(current.id));
        result.push(String(current.id));
        if (!isPromptDeltaProfile(current)) break;
        current = getProfile(meta, current.baseId);
    }
    return result;
}




