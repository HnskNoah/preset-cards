// profile 级纯数据变换：派生构造与级联删除的纯计算。
// 不接触 dialog/DOM；事件 handler 调用后自行持久化与刷新 UI。

import { isPromptDeltaProfile, newProfileId } from './meta.js';
import type { PresetMeta, PresetProfileV1, PromptBaseProfile, PromptDeltaChange, PromptDeltaProfile, PromptSampling } from './meta.js';
import { buildBaseSnapshotDiff, captureExtra, capturePromptFields } from './promptToggle.js';
import type { Preset } from './meta.js';
import { SAMPLING_KEYS } from './constants.js';

// 派生新 delta profile 的纯数据构造：「保存为子配置」与「从 base 派生」共用。
// changes 为空数组表示与上级 profile 完全相同的初始 delta，后续通过「覆盖」更新差异。
export function buildDerivedProfile(
    parent: PromptBaseProfile | PromptDeltaProfile,
    name: string,
    changes: PromptDeltaChange[] = [],
    sampling?: PromptSampling,
): PromptDeltaProfile {
    return {
        formatVersion: 2,
        kind: 'prompt_delta',
        id: newProfileId(),
        name,
        baseId: parent.id,
        changes,
        ...(sampling ? { sampling } : {}),
    };
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

// v1 → v2 迁移：把旧版全量预设快照（settings）转成 prompt_base。
// - prompts：仅当前目标 prompt_order.order 中的条目，开关取 runtimeEnabledFor（global 100001），
//   值字段取白名单键（v1 无基线，走「开关 + 全量 fields」退化分支，等价 buildBaseSnapshotDiff(preset, null)）。
//   退化兜底：源数据有 prompts 但目标 order 不可解析（旧对象格式 / 缺目标角色 order）导致快照为空时，
//   回退采集全部 preset.prompts（不丢数据），开关取各自 prompts 的 enabled（缺失视为 false）。
// - sampling：从 v1.settings 提取 SAMPLING_KEYS 全部采样键（存在才写入），实现「v1 采样参数不丢失」。
// - extra：v1 存的但 v2 无结构对应的其余键（impersonation_prompt、bias_preset_selected 等）原样保留；
//   jailbreak 旧独立字段有内容且 prompts 含 identifier='jailbreak' 条目时映射进其 fields.content。
export function convertV1ToBase(v1: PresetProfileV1): PromptBaseProfile {
    const settings = v1.settings as Preset;
    let prompts = buildBaseSnapshotDiff(settings, null);
    if (prompts.length === 0 && Array.isArray(settings.prompts) && settings.prompts.length > 0) {
        // 目标 order 不可解析：降级全量采集，避免 v1 迁移丢 prompt
        prompts = settings.prompts
            .filter((p: any) => p && typeof p.identifier === 'string' && p.identifier)
            .map((p: any) => ({
                identifier: p.identifier,
                enabled: p.enabled === true,
                ...(Object.keys(capturePromptFields(p)).length > 0 ? { fields: capturePromptFields(p) } : {}),
            }));
    }
    const sampling: PromptSampling = {};
    for (const key of SAMPLING_KEYS) {
        const value = (settings as Record<string, unknown>)[key];
        if (value !== undefined) (sampling as Record<string, unknown>)[key] = value;
    }
    const extra = captureExtra(settings as Record<string, unknown>);
    // jailbreak 旧独立字段映射：有内容且 prompts 里有 identifier='jailbreak' 条目 → 写入 fields.content，并从 extra 移除
    const jb = (settings as Record<string, unknown>)['jailbreak'];
    if (typeof jb === 'string' && jb.length > 0) {
        const jbEntry = prompts.find((p) => p.identifier === 'jailbreak');
        if (jbEntry) {
            jbEntry.fields = { ...(jbEntry.fields ?? {}), content: jb };
            if (extra) delete extra['jailbreak'];
        }
    }
    return {
        formatVersion: 2,
        kind: 'prompt_base',
        id: v1.id || newProfileId(),
        name: v1.name,
        prompts,
        ...(Object.keys(sampling).length > 0 ? { sampling } : {}),
        ...(extra ? { extra } : {}),
    };
}
