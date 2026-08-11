// profile 级纯数据变换：派生构造与级联删除的纯计算。
// 不接触 dialog/DOM；事件 handler 调用后自行持久化与刷新 UI。

import { isPromptDeltaProfile, newProfileId } from './meta.js';
import type { PresetMeta, PresetProfileV1, PromptBaseProfile, PromptDeltaChange, PromptDeltaProfile, PromptProfileEntry, PromptSampling } from './meta.js';
import { captureExtra, capturePromptFields } from './promptToggle.js';
import type { Preset } from './meta.js';
import { SAMPLING_KEYS } from './constants.js';
import { snapshotPromptState } from './promptState.js';

/** fv3 base 工厂：统一可选字段拼接（unusedIds/sampling/extra/archive）。 */
export function makeBaseProfile(p: {
    id: string;
    name: string;
    prompts: PromptProfileEntry[];
    unusedIds?: string[];
    sampling?: PromptSampling;
    extra?: Record<string, any>;
    archive?: true;
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
        ...(p.archive ? { archive: true } : {}),
    };
}

/** fv3 delta 工厂：统一可选字段拼接（order/sampling/extra）。 */
export function makeDeltaProfile(p: {
    id: string;
    name: string;
    baseId: string;
    changes: PromptDeltaChange[];
    order?: string[];
    sampling?: PromptSampling;
    extra?: Record<string, any>;
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
): PromptDeltaProfile {
    return makeDeltaProfile({ id: newProfileId(), name, baseId: parent.id, changes, ...(sampling ? { sampling } : {}), ...(order ? { order } : {}) });
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

// v1 → v3 迁移：把旧版全量预设快照（settings）转成 prompt_base（fv3）。
// - prompts：完整挂载态（mounted/unused）——order 中的条目 mounted + enabled，order 外的记 unusedIds；
//   值字段取白名单键（v1 无基线，走「开关 + 全量 fields」退化分支）。
//   退化兜底：源数据有 prompts 但目标 order 不可解析（旧对象格式 / 缺目标角色 order）导致快照为空时，
//   回退采集全部 preset.prompts（不丢数据），开关取各自 prompts 的 enabled（缺失视为 false）。
// - sampling：从 v1.settings 提取 SAMPLING_KEYS 全部采样键（存在才写入），实现「v1 采样参数不丢失」。
// - extra：v1 存的但 v3 无结构对应的其余键（impersonation_prompt、bias_preset_selected 等）原样保留；
//   jailbreak 旧独立字段有内容且 prompts 含 identifier='jailbreak' 条目时映射进其 fields.content。
export function convertV1ToBase(v1: PresetProfileV1, opts?: { archive?: boolean }): PromptBaseProfile {
    const settings = v1.settings as Preset;
    const prompts = Array.isArray(settings.prompts)
        ? settings.prompts.filter((p: any) => p && typeof p.identifier === 'string' && p.identifier)
        : [];
    const order = Array.isArray(settings.prompt_order)
        ? settings.prompt_order.find((l: any) => l && String(l.character_id) === '100001')?.order ?? []
        : [];
    let { entries, unusedIds } = snapshotPromptState(prompts, Array.isArray(order) ? order : []);
    // 值字段：无基线，全量写入（mounted 条目）
    entries = entries.map((e) => {
        const prompt = prompts.find((p: any) => p.identifier === e.identifier);
        const fields = capturePromptFields(prompt);
        if (Object.keys(fields).length > 0) e.fields = fields;
        return e;
    });
    const sampling: PromptSampling = {};
    for (const key of SAMPLING_KEYS) {
        const value = (settings as Record<string, unknown>)[key];
        if (value !== undefined) (sampling as Record<string, unknown>)[key] = value;
    }
    const extra = captureExtra(settings as Record<string, unknown>);
    // jailbreak 旧独立字段映射：有内容且 prompts 里有 identifier='jailbreak' 条目 → 写入 fields.content，并从 extra 移除
    const jb = (settings as Record<string, unknown>)['jailbreak'];
    if (typeof jb === 'string' && jb.length > 0) {
        const jbEntry = entries.find((e) => e.identifier === 'jailbreak');
        if (jbEntry) {
            jbEntry.fields = { ...(jbEntry.fields ?? {}), content: jb };
            if (extra) delete extra['jailbreak'];
        }
    }
    return makeBaseProfile({
        id: v1.id || newProfileId(),
        name: v1.name,
        prompts: entries,
        ...(unusedIds.length > 0 ? { unusedIds } : {}),
        ...(opts?.archive ? { archive: true } : {}),
        ...(Object.keys(sampling).length > 0 ? { sampling } : {}),
        ...(extra ? { extra } : {}),
    });
}

// 从导入的 v1 文件构造隐藏只读存档 base（archive）。作为 preset 的相对基线。
export function buildArchiveBase(v1: PresetProfileV1): PromptBaseProfile {
    return convertV1ToBase(v1, { archive: true });
}

// 判断 profile 是否为导入存档 base（只读隐藏）。
export function isArchiveProfile(profile: PromptBaseProfile | PromptDeltaProfile): boolean {
    return (profile as PromptBaseProfile).archive === true;
}
