import { L } from './i18n.js';
import { getProfile, isPromptBaseProfile, isPromptDeltaProfile, newProfileId, saveMeta } from './meta.js';
import type { Preset, PresetMeta, PromptBaseProfile, PromptDefaultSnapshotEntry, PromptDeltaProfile, PromptProfileEntry } from './meta.js';
import { applyBaseProfile, applyModel, buildBaseSnapshot, captureExtra, captureModel, captureSampling, resolveParentStates, resolveProfileModel } from './promptToggle.js';
import { applyDefaultExtra, applyDefaultModel, applyDefaultOriginalFields, applyDefaultSampling, defaultEnabledEntries } from './presetSnapshot.js';

/** 构造 add base 的 fv3 主 profile（mounted 完整 + unusedIds + 采样/extra 差异）。 */
export function buildNewBaseProfile(
    preset: Preset,
    baseline: PromptDefaultSnapshotEntry[] | null | undefined,
    name: string,
): PromptBaseProfile {
    const snapshot = buildBaseSnapshot(preset, baseline);
    const sampling = captureSampling(preset);
    const extra = captureExtra(preset as Record<string, unknown>);
    const model = captureModel(preset);
    return {
        formatVersion: 3,
        kind: 'prompt_base',
        id: newProfileId(),
        name,
        prompts: snapshot.entries,
        ...(snapshot.unusedIds.length > 0 ? { unusedIds: snapshot.unusedIds } : {}),
        ...(sampling ? { sampling } : {}),
        ...(extra ? { extra } : {}),
        ...(model ? { model } : {}),
    };
}

/** 构造「reset 到父链/默认」的临时 base profile 对象。 */
export function buildResetBaseProfile(
    id: string,
    name: string,
    prompts: PromptProfileEntry[],
): PromptBaseProfile {
    return { formatVersion: 3, kind: 'prompt_base', id, name, prompts };
}

/** 出厂基线的 unused 集合（reset 时重算 base.unusedIds）。
 * 兼容旧版 v2 快照：mounted 缺失时按「有 enabled 布尔即 mounted」推断（与 entriesFromDefaultSnapshot 一致）。 */
export function defaultUnusedIds(meta: PresetMeta): string[] {
    return (meta.defaultSnapshot ?? [])
        .filter((e) => (e.mounted ?? (typeof e.enabled === 'boolean')) === false)
        .map((e) => e.identifier);
}

/** reset 到父链 / 隐藏默认的共享核心（profile editor 与卡片 reset 共用）。
 * 纯数据变换 + saveMeta + toastr；UI 刷新（refreshActivePresetUI / clearBuffered / refreshGrid）由调用方处理。
 * 返回 'reset'（成功）| 'no-default' | null（无默认基线或 profile 类型不可 reset）。 */
export async function resetProfileCore(
    preset: Preset,
    meta: PresetMeta,
    profile: PromptBaseProfile | PromptDeltaProfile,
    name: string,
    idx: number,
): Promise<'reset' | 'no-default' | null> {
    if (isPromptDeltaProfile(profile)) {
        const parentStates = resolveParentStates(profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]);
        const parent = getProfile(meta, profile.baseId);
        const parentModel = parent ? resolveProfileModel(parent, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]) : undefined;
        const defaultModel = meta.defaultModel;
        const model = parentModel ?? defaultModel;
        if (parentStates.length > 0) {
            applyBaseProfile(preset, buildResetBaseProfile(profile.baseId || 'parent', 'Parent', parentStates));
            profile.changes = [];
            delete profile.sampling;
            delete profile.order;
            delete profile.extra;
            if (model) {
                profile.model = model;
                applyModel(preset, model);
            } else {
                delete profile.model;
            }
            applyDefaultSampling(preset, meta);
            applyDefaultExtra(preset, meta);
        } else {
            if (!meta.defaultSnapshot || meta.defaultSnapshot.length === 0) {
                toastr.warning(L('No default baseline available'));
                return 'no-default';
            }
            applyDefaultOriginalFields(preset, meta);
            applyDefaultSampling(preset, meta);
            applyDefaultExtra(preset, meta);
            applyDefaultModel(preset, meta);
            const defaultPrompts = defaultEnabledEntries(meta);
            applyBaseProfile(preset, buildResetBaseProfile(profile.baseId || 'default', 'Default', defaultPrompts));
            profile.changes = [];
            delete profile.sampling;
            delete profile.order;
            delete profile.extra;
            if (defaultModel) profile.model = defaultModel;
            else delete profile.model;
        }
        await saveMeta(name, idx, meta);
        toastr.success(L('Configuration reset'));
        return 'reset';
    }
    if (isPromptBaseProfile(profile)) {
        if (!meta.defaultSnapshot || meta.defaultSnapshot.length === 0) {
            toastr.warning(L('No default baseline available'));
            return 'no-default';
        }
        applyDefaultOriginalFields(preset, meta);
        applyDefaultSampling(preset, meta);
        applyDefaultExtra(preset, meta);
        applyDefaultModel(preset, meta);
        const defaultPrompts = defaultEnabledEntries(meta);
        profile.prompts = structuredClone(defaultPrompts);
        const defaultUnused = defaultUnusedIds(meta);
        if (defaultUnused.length > 0) profile.unusedIds = defaultUnused;
        else delete profile.unusedIds;
        delete profile.sampling;
        delete profile.extra;
        if (meta.defaultModel) profile.model = meta.defaultModel;
        else delete profile.model;
        applyBaseProfile(preset, buildResetBaseProfile(profile.id, profile.name, defaultPrompts));
        await saveMeta(name, idx, meta);
        toastr.success(L('Configuration reset'));
        return 'reset';
    }
    toastr.warning(L('This profile type cannot be reset'));
    return null;
}
