import { L } from './i18n.js';
import { getProfile, isPromptBaseProfile, isPromptDeltaProfile, newProfileId, persistMetaTransaction } from './meta.js';
import type { Preset, PresetMeta, PromptBaseProfile, PromptDefaultSnapshotEntry, PromptDeltaProfile, PromptProfileEntry, PromptSampling } from './meta.js';
import { applyBaseProfile, applyExtra, applyModel, applySampling, buildBaseSnapshot, captureExtra, captureModel, captureSampling, diffExtra, diffSampling, resolveEffectiveExtra, resolveEffectiveSampling, resolveParentStates, resolveProfileModel } from './promptToggle.js';
import { applyDefaultExtra, applyDefaultModel, applyDefaultOriginalFields, applyDefaultSampling, defaultEnabledEntries } from './presetSnapshot.js';

/** 构造 add base 的 fv3 主 profile（mounted 完整 + unusedIds + 采样/extra sparse 差异）。 */
export function buildNewBaseProfile(
    preset: Preset,
    baseline: PromptDefaultSnapshotEntry[] | null | undefined,
    name: string,
    defaultSampling?: PromptSampling,
    defaultExtra?: Record<string, any>,
): PromptBaseProfile {
    const snapshot = buildBaseSnapshot(preset, baseline);
    const sampling = diffSampling(captureSampling(preset), defaultSampling);
    const extra = diffExtra(captureExtra(preset as Record<string, unknown>), defaultExtra);
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
 * 副本模式事务：先构造重置后的 profile 副本并持久化，成功后才同步 live profile + 应用运行时；
 * 保存失败时不污染内存（后续保存不会把「失败的重置」写盘）。
 * 返回 'reset'（成功）| 'no-default' | null（无默认基线 / 落盘失败 / profile 类型不可 reset）。 */
export async function resetProfileCore(
    preset: Preset,
    meta: PresetMeta,
    profile: PromptBaseProfile | PromptDeltaProfile,
    name: string,
    idx: number,
): Promise<'reset' | 'no-default' | null> {
    if (isPromptDeltaProfile(profile)) {
        const allProfiles = meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[];
        const parentStates = resolveParentStates(profile, allProfiles);
        const parent = getProfile(meta, profile.baseId);
        const parentModel = parent ? resolveProfileModel(parent, allProfiles) : undefined;
        const defaultModel = meta.defaultModel;
        const model = parentModel ?? defaultModel;
        const parentSampling = parent ? resolveEffectiveSampling(parent, allProfiles, meta.defaultSampling) : undefined;
        const parentExtra = parent ? resolveEffectiveExtra(parent, allProfiles, meta.defaultExtra) : undefined;
        const nextProfile = structuredClone(profile) as PromptDeltaProfile;
        if (parentStates.length > 0) {
            nextProfile.changes = [];
            delete nextProfile.order;
            // 清空自身 sampling/extra/model：继承父链解析态（加载时链式解析自然还原，含出厂基线回退）
            delete nextProfile.sampling;
            delete nextProfile.extra;
            delete nextProfile.model;
        } else {
            if (!meta.defaultSnapshot || meta.defaultSnapshot.length === 0) {
                toastr.warning(L('No default baseline available'));
                return 'no-default';
            }
            nextProfile.changes = [];
            delete nextProfile.sampling;
            delete nextProfile.order;
            delete nextProfile.extra;
            delete nextProfile.model;
        }
        const ok = await persistMetaTransaction(meta, (m) => ({
            ...m,
            profiles: (m.profiles || []).map((p) => String(p.id) === String(profile.id) ? nextProfile : p),
        }), name, idx);
        if (!ok) return null;

        // 成功后同步 live profile（保持引用身份）并应用运行时
        Object.assign(profile, nextProfile);
        for (const key of ['order', 'sampling', 'extra', 'model'] as const) {
            if (!(key in nextProfile)) delete (profile as any)[key];
        }
        if (parentStates.length > 0) {
            applyBaseProfile(preset, buildResetBaseProfile(profile.baseId || 'parent', 'Parent', parentStates));
            if (model) applyModel(preset, model);
            if (parentSampling) applySampling(preset, parentSampling);
            if (parentExtra) applyExtra(preset, parentExtra);
        } else {
            applyDefaultOriginalFields(preset, meta);
            applyDefaultSampling(preset, meta);
            applyDefaultExtra(preset, meta);
            applyDefaultModel(preset, meta);
            const defaultPrompts = defaultEnabledEntries(meta);
            applyBaseProfile(preset, buildResetBaseProfile(profile.baseId || 'default', 'Default', defaultPrompts));
        }
        toastr.success(L('Configuration reset'));
        return 'reset';
    }
    if (isPromptBaseProfile(profile)) {
        if (!meta.defaultSnapshot || meta.defaultSnapshot.length === 0) {
            toastr.warning(L('No default baseline available'));
            return 'no-default';
        }
        const nextProfile = structuredClone(profile) as PromptBaseProfile;
        const defaultPrompts = defaultEnabledEntries(meta);
        nextProfile.prompts = structuredClone(defaultPrompts);
        const defaultUnused = defaultUnusedIds(meta);
        if (defaultUnused.length > 0) nextProfile.unusedIds = defaultUnused;
        else delete nextProfile.unusedIds;
        delete nextProfile.sampling;
        delete nextProfile.extra;
        delete nextProfile.model;
        const ok = await persistMetaTransaction(meta, (m) => ({
            ...m,
            profiles: (m.profiles || []).map((p) => String(p.id) === String(profile.id) ? nextProfile : p),
        }), name, idx);
        if (!ok) return null;

        // 成功后同步 live profile + 应用运行时
        Object.assign(profile, nextProfile);
        for (const key of ['unusedIds', 'sampling', 'extra', 'model'] as const) {
            if (!(key in nextProfile)) delete (profile as any)[key];
        }
        applyDefaultOriginalFields(preset, meta);
        applyDefaultSampling(preset, meta);
        applyDefaultExtra(preset, meta);
        applyDefaultModel(preset, meta);
        applyBaseProfile(preset, buildResetBaseProfile(profile.id, profile.name, defaultPrompts));
        toastr.success(L('Configuration reset'));
        return 'reset';
    }
    toastr.warning(L('This profile type cannot be reset'));
    return null;
}
