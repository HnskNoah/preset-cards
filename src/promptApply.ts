import { L } from './i18n.js';
import { isPromptBaseProfile, isPromptDeltaProfile } from './meta.js';
import type { Preset, PresetProfile, PromptBaseProfile, PromptDefaultSnapshotEntry, PromptDeltaProfile, PromptProfileEntry, PromptSampling } from './meta.js';
import { SAMPLING_KEYS } from './constants.js';
import { filterFields, applySampling, applyExtra, capturePromptFields, findPromptInPreset, EXTRA_EXCLUDED_KEYS } from './promptCapture.js';
import { findOrderList, resolvePromptOrderTarget, replaceTargetPromptOrder, syncPromptOrder, resolveProfilePrompts, pruneStaleOrderEntries } from './promptOrder.js';
import { snapshotPromptState, isNeverCaptureIdentifier } from './promptState.js';

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

/**
 * 加载配置的核心分支（base / delta / v1）。
 * - v3 base/delta：resolve → applyResolvedPromptState（mounted/unused 精确还原）；
 * - v1：定义并集对齐（profile 有而 preset 无 → 补进；preset 有而 profile 无 → 标 unused；仅挂载的进 order）。
 */
export function applyProfileToPreset(
    preset: Preset,
    profile: PresetProfile,
    allProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
    opts?: { showMissingToast?: boolean },
): void {
    pruneStaleOrderEntries(preset);

    if (isPromptBaseProfile(profile)) {
        applyResolvedPromptState(preset, resolveProfilePrompts(profile, allProfiles));
        if (profile.sampling) applySampling(preset, profile.sampling);
        if (profile.extra) applyExtra(preset, profile.extra);
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
        if (profile.sampling) applySampling(preset, profile.sampling);
        if (profile.extra) applyExtra(preset, profile.extra);
    } else {
        // v1 全量快照：定义并集对齐（补进/覆盖/保留 + 挂载还原 + 采样/附加快照回放），不整份覆盖
        applyV1UnionAlign(preset, profile.settings);
    }
}

/**
 * v1 全量快照的定义并集对齐应用（替代 Object.assign 整份覆盖）：
 * - 定义集合并集：v1 有而 preset 无 → 补进；v1 有而 preset 有 → 覆盖（对齐编辑结果）；
 *   preset 有而 v1 无 → 保留（不挂载 = unused），不误删保存 profile 后用户新加的定义。
 * - 挂载还原：按 v1 的 prompt_order（global 100001）重建目标 order；孤立引用（v1 order 里无定义）过滤。
 * - 采样 / 附加快照：v1.settings 里的采样键与其余键分别经 applySampling / applyExtra 回放。
 */
function applyV1UnionAlign(preset: Preset, v1Settings: Record<string, any>): void {
    const v1Prompts = Array.isArray(v1Settings.prompts) ? v1Settings.prompts : [];
    const v1ById = new Map<string, any>();
    for (const p of v1Prompts) {
        if (p && typeof p.identifier === 'string' && p.identifier && !isNeverCaptureIdentifier(p.identifier)) v1ById.set(p.identifier, p);
    }
    if (!Array.isArray(preset.prompts)) preset.prompts = [];

    // 定义集合并集：补进 / 覆盖 / 保留（PROMPT_NEVER_CAPTURE 如 SPresetSettings 一律跳过，由扩展自管理）
    const presetById = new Map<string, any>();
    for (const p of preset.prompts) {
        if (p && typeof p.identifier === 'string' && p.identifier && !isNeverCaptureIdentifier(p.identifier)) presetById.set(p.identifier, p);
    }
    for (const [id, v1p] of v1ById) {
        const existing = presetById.get(id);
        if (existing) {
            Object.assign(existing, structuredClone(v1p));
        } else {
            preset.prompts.push(structuredClone(v1p));
        }
    }

    // 挂载还原：v1 order（global 100001）重建目标 order；无 v1 order 则只对齐定义、不碰挂载。
    // PROMPT_NEVER_CAPTURE 的 identifier 不进入重建的 order（保持 preset 现状）。
    const v1OrderList = Array.isArray(v1Settings.prompt_order)
        ? v1Settings.prompt_order.find((l: any) => l && String(l.character_id) === '100001')
        : undefined;
    if (v1OrderList && Array.isArray(v1OrderList.order)) {
        const allIds = new Set([...presetById.keys(), ...v1ById.keys()]);
        const v1Order = v1OrderList.order
            .filter((o: any) => o && typeof o.identifier === 'string' && allIds.has(o.identifier) && !isNeverCaptureIdentifier(o.identifier))
            .map((o: any) => ({ identifier: o.identifier, enabled: o.enabled === true }));
        const list = findOrderList(preset, 100001);
        if (list) {
            list.order = v1Order;
        } else {
            if (!Array.isArray(preset.prompt_order)) preset.prompt_order = [];
            preset.prompt_order.push({ character_id: 100001, order: v1Order });
        }
    }

    // 采样回放：v1 里的采样键
    const sampling: PromptSampling = {};
    for (const key of SAMPLING_KEYS) {
        const value = (v1Settings as Record<string, unknown>)[key];
        if (value !== undefined) (sampling as Record<string, unknown>)[key] = value;
    }
    if (Object.keys(sampling).length > 0) applySampling(preset, sampling);

    // 附加快照回放：v1 里非 prompts/order/采样/连接键的其余键
    const ext = preset.extensions;
    const extra: Record<string, any> = {};
    for (const [key, value] of Object.entries(v1Settings)) {
        if (SAMPLING_KEYS.some((k) => k === key)) continue;
        if (EXTRA_EXCLUDED_KEYS.has(key)) continue;
        extra[key] = value;
    }
    if (Object.keys(extra).length > 0) {
        Object.assign(preset, extra);
        preset.extensions = ext;
    }
}
