import { L } from './i18n.js';
import { getProfile, isPromptBaseProfile, isPromptDeltaProfile } from './meta.js';
import type { Preset, PresetMeta, PresetProfile, PromptBaseProfile, PromptDefaultSnapshotEntry, PromptDeltaProfile, PromptModel, PromptProfileEntry, PromptSampling } from './meta.js';
import { filterFields, applySampling, applyExtra, applyModel, capturePromptFields, findPromptInPreset } from './promptCapture.js';
import { findOrderList, resolvePromptOrderTarget, replaceTargetPromptOrder, syncPromptOrder, resolveProfilePrompts, pruneStaleOrderEntries } from './promptOrder.js';
import { snapshotPromptState } from './promptState.js';
import { applyExtensions } from './extApply.js';

/**
 * 单条开关应用到预设实际值：改 prompts[].enabled 并同步 prompt_order。
 * 返回是否匹配到该 identifier。
 */
export function applyEntryState(preset: Preset, identifier: string, enabled: boolean): boolean {
    const prompt = findPromptInPreset(preset, identifier);
    if (!prompt) return false;

    prompt.enabled = enabled;
    syncPromptOrder(preset, [{ identifier, enabled }]);
    return true;
}

/**
 * 全量锁定快照（v3）：全部 prompts 采集挂载态 + 开关 + 白名单值字段。
 * order 中的 prompt → mounted（enabled 取 order 真值，lastActiveIndex 记录顺序）；
 * order 外的 prompt → mounted=false（unused，enabled 用定义层默认）。
 * 作为 reset 的出厂基线（lockDefaultSnapshot 用）。
 */
export function buildDefaultSnapshotLock(preset: Preset): PromptDefaultSnapshotEntry[] {
    if (!Array.isArray(preset.prompts)) return [];
    const target = resolvePromptOrderTarget();
    const prompts = preset.prompts
        .filter((p: any) => p && typeof p.identifier === 'string' && p.identifier);
    const list = findOrderList(preset, target);
    const { entries, unusedIds } = snapshotPromptState(prompts, Array.isArray(list?.order) ? list.order : []);
    const mounted = entries.map((e) => ({
        identifier: e.identifier,
        mounted: true,
        enabled: e.enabled,
        ...(e.lastActiveIndex !== undefined ? { lastActiveIndex: e.lastActiveIndex } : {}),
        originalFields: capturePromptFields(findPromptInPreset(preset, e.identifier)),
    }));
    // unused 条目也进出厂基线（mounted:false），供 reset 还原 unused 集合 / profileDiffersFromDefault 判定差异
    const unused = unusedIds.map((identifier) => ({
        identifier,
        mounted: false,
        enabled: false,
        originalFields: capturePromptFields(findPromptInPreset(preset, identifier)),
    }));
    return [...mounted, ...unused];
}

/**
 * 应用 resolved 挂载状态到 preset：
 * - 逐条按 identifier 应用 enabled/fields（定义缺失则 missing）；
 * - 整条替换目标 prompt_order 为 mounted 条目（unused/后加定义不挂载）。
 * 返回匹配计数与缺失 identifier 列表。
 */
export function applyResolvedPromptState(
    preset: Preset,
    entries: PromptProfileEntry[],
): { matched: number; missing: string[] } {
    const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    const byId = new Map<string, any>(
        prompts.filter((p: any) => p && typeof p.identifier === 'string' && p.identifier).map((p: any) => [p.identifier, p]),
    );
    const missing: string[] = [];
    let matched = 0;
    for (const entry of entries) {
        const prompt = byId.get(entry.identifier);
        if (!prompt) {
            missing.push(entry.identifier);
            continue;
        }
        if (entry.mounted) prompt.enabled = entry.enabled;
        if (entry.fields) Object.assign(prompt, filterFields(entry.fields));
        matched++;
    }
    replaceTargetPromptOrder(preset, entries);
    return { matched, missing };
}

/** v2 兼容：按 identifier 回写 enabled + 同步 prompt_order（仅 mounted 条目）。 */
export function applyBaseProfile(preset: Preset, profile: PromptBaseProfile): void {
    applyResolvedPromptState(preset, profile.prompts);
}

/** 沿父链回溯解析 profile 的某个可选字段（自身未记录时上溯，含防环）。 */
function resolveProfileField<T>(
    profile: PresetProfile,
    allProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
    pick: (p: PromptBaseProfile | PromptDeltaProfile) => T | undefined,
): T | undefined {
    if (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile)) return undefined;
    const seen = new Set<string>();
    let current: PresetProfile | undefined = profile;
    while (current && (isPromptBaseProfile(current) || isPromptDeltaProfile(current))) {
        const id = String(current.id);
        if (seen.has(id)) return undefined;
        seen.add(id);
        const value = pick(current);
        if (value !== undefined) return value;
        if (isPromptDeltaProfile(current)) {
            current = getProfile({ profiles: allProfiles } as PresetMeta, current.baseId);
        } else {
            current = undefined;
        }
    }
    return undefined;
}

/** 解析 profile 的模型快照：优先自身 model，delta 未记录时沿父链回溯（含防环）。 */
export function resolveProfileModel(
    profile: PresetProfile,
    allProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
): PromptModel | undefined {
    return resolveProfileField(profile, allProfiles, (p) => p.model);
}

/** 收集 profile 的完整祖先链（根在前、自身在末）；成环/父缺失时返回已收集部分。 */
export function collectProfileChain(
    profile: PresetProfile,
    allProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
): (PromptBaseProfile | PromptDeltaProfile)[] {
    const chain: (PromptBaseProfile | PromptDeltaProfile)[] = [];
    const seen = new Set<string>();
    let current: PresetProfile | undefined = profile;
    while (current && (isPromptBaseProfile(current) || isPromptDeltaProfile(current)) && !seen.has(String(current.id))) {
        seen.add(String(current.id));
        chain.unshift(current);
        if (isPromptDeltaProfile(current)) {
            const baseId: string = current.baseId;
            current = allProfiles.find((p) => String(p.id) === String(baseId));
        } else {
            current = undefined;
        }
    }
    return chain;
}

/** 解析 profile 的有效采样：出厂基线 ⊕ 祖先链各层 sparse 差异依次叠加。 */
export function resolveEffectiveSampling(
    profile: PresetProfile,
    allProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
    defaultSampling?: PromptSampling,
): PromptSampling | undefined {
    if (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile)) return undefined;
    const merged: Record<string, unknown> = { ...(defaultSampling ?? {}) };
    for (const p of collectProfileChain(profile, allProfiles)) {
        if (!p.sampling) continue;
        for (const [key, value] of Object.entries(p.sampling)) {
            if (value !== undefined) merged[key] = value;
        }
    }
    return Object.keys(merged).length > 0 ? (merged as PromptSampling) : undefined;
}

/** 解析 profile 的有效 extra：出厂基线 ⊕ 祖先链各层 sparse 差异依次叠加。 */
export function resolveEffectiveExtra(
    profile: PresetProfile,
    allProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
    defaultExtra?: Record<string, any>,
): Record<string, any> | undefined {
    if (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile)) return undefined;
    const merged: Record<string, any> = { ...(defaultExtra ?? {}) };
    for (const p of collectProfileChain(profile, allProfiles)) {
        if (p.extra) Object.assign(merged, p.extra);
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
}

export function applyProfileToPreset(
    preset: Preset,
    profile: PresetProfile,
    allProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
    opts?: { showMissingToast?: boolean; defaultSampling?: PromptSampling; defaultExtra?: Record<string, any>; defaultModel?: PromptModel; defaultSnapshot?: PromptDefaultSnapshotEntry[] },
): void {
    pruneStaleOrderEntries(preset);

    // 先恢复出厂基线字段，再叠加 profile 的 sparse fields：避免前一个 profile 的字段残留到当前加载结果
    if (opts?.defaultSnapshot) {
        for (const d of opts.defaultSnapshot) {
            if (!d.originalFields) continue;
            const prompt = findPromptInPreset(preset, d.identifier);
            if (prompt) Object.assign(prompt, filterFields(d.originalFields));
        }
    }

    const model = resolveProfileModel(profile, allProfiles) ?? opts?.defaultModel;
    if (model) applyModel(preset, model);

    if (isPromptBaseProfile(profile)) {
        const states = resolveProfilePrompts(profile, allProfiles);
        if (states.length === 0) {
            // 空解析（如导入锚点 base 的 prompts:[]）绝不 applyResolvedPromptState([])，那会清空目标 prompt_order
            toastr.warning(L('No prompts to apply'));
        } else {
            applyResolvedPromptState(preset, states);
        }
    } else if (isPromptDeltaProfile(profile)) {
        const states = resolveProfilePrompts(profile, allProfiles);
        if (states.length === 0) {
            // 父链缺失/成环导致解析为空：只提示，绝不 applyResolvedPromptState([])（那会清空目标 prompt_order）
            toastr.warning(L('Base profile not found, applying changes only'));
        } else {
            const { missing } = applyResolvedPromptState(preset, states);
            if (opts?.showMissingToast && missing.length > 0) {
                toastr.warning(`${L('Missing prompts skipped')}: ${missing.join(', ')}`);
            }
        }
    }

    const sampling = resolveEffectiveSampling(profile, allProfiles, opts?.defaultSampling);
    if (sampling) applySampling(preset, sampling);
    const extra = resolveEffectiveExtra(profile, allProfiles, opts?.defaultExtra);
    if (extra) applyExtra(preset, extra);

    // 扩展覆盖沿父链依次应用（祖先 → 自身）：开关后写者胜、后代可摘除祖先挂载的条目、
    // 各层新增条目并存；applyExtensions 自带按 id 去重与 no-op 摘除。
    for (const p of collectProfileChain(profile, allProfiles)) {
        if (p.extProfile) applyExtensions(preset, p.extProfile);
    }
}

