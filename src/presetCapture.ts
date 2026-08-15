// presetCapture：切片 3 保存捕获（SETTINGS_UPDATED → 原生编辑自动吸收进 profile）。
// 门：仅当活动预设是注册 profile（marker kind='profile'）时执行；
// diff 运行时（oai_settings）vs 注册记录 → 捕获回 profile delta + 材料留池/新增入父池 +
// 刷新注册记录（onMetaPersisted → sync 自动完成）。无漂移时零写入（防重入）。
import { eventSource, event_types } from '@sillytavern/scripts/events';
import { openai_settings, openai_setting_names, oai_settings, settingsToUpdate } from '@sillytavern/scripts/openai';
import { getProfile, isPromptBaseProfile, isPromptDeltaProfile, persistMetaTransaction, readMeta } from './meta.js';
import type { Preset, PresetProfile, PromptBaseProfile, PromptDeltaProfile, PromptModel, PromptSampling } from './meta.js';
import { readPresetMarker } from './core/storage/marker.js';
import {
    applyPromptDriftToProfile,
    computePromptDrift,
    isEmptyPromptDrift,
} from './core/capture/drift.js';
import {
    captureExtra,
    captureModel,
    captureSampling,
    diffExtra,
    diffSampling,
    resolveEffectiveExtra,
    resolveEffectiveSampling,
    resolveProfileModel,
} from './promptToggle.js';

/** 防重入：捕获期间再次 SETTINGS_UPDATED 直接跳过（等待本次落盘后再对账）。 */
let capturing = false;

/** 初始化保存捕获：监听 SETTINGS_UPDATED（ST 保存落盘成功后触发；原生 PM 每次编辑都以它收尾）。init.ts 调用。 */
export function initPresetCapture(): void {
    eventSource.on(event_types.SETTINGS_UPDATED, () => {
        void captureIfRegistered().catch((err) => console.error('preset-cards: capture failed', err));
    });
}

/** 门 + 捕获：活动预设是注册 profile 时，把运行时漂移捕获回 profile。返回是否发生变更（含持久化成功）。 */
export async function captureIfRegistered(): Promise<boolean> {
    if (capturing) return false;
    const activeName = oai_settings.preset_settings_openai;
    if (typeof activeName !== 'string') return false;
    const idx = openai_setting_names[activeName];
    if (idx === undefined) return false;
    const record = openai_settings[idx] as Record<string, any> | undefined;
    if (!record) return false;
    const marker = readPresetMarker(record);
    if (!marker || marker.kind !== 'profile' || !marker.parentKey || !marker.profileId) return false;
    const parentIdx = openai_setting_names[marker.parentKey];
    if (parentIdx === undefined) return false;
    const parent = openai_settings[parentIdx] as Preset | undefined;
    if (!parent || !Array.isArray(oai_settings.prompts)) return false;

    capturing = true;
    try {
        const drift = computePromptDrift(oai_settings as any, record);
        // 顶层（采样/extra/模型）漂移：仅当「运行时 vs 注册记录」确有差异才计算 v3 diff
        const top = topLevelKeysDiffer(oai_settings as any, record)
            ? computeTopLevelDrift(parent, marker.profileId, oai_settings as any)
            : {};
        if (isEmptyPromptDrift(drift) && Object.keys(top).length === 0) return false;

        // 材料恢复（删除）/ 新增入父池：dormant prompt 定义进父预设 prompts[]（不挂载，仅池）
        const parentPrompts = Array.isArray(parent.prompts) ? parent.prompts : (parent.prompts = []);
        const known = new Set(
            parentPrompts.map((p: any) => p?.identifier).filter((id: unknown): id is string => typeof id === 'string'),
        );
        for (const id of drift.deleted) {
            const def = Array.isArray(record.prompts)
                ? record.prompts.find((p: any) => p?.identifier === id)
                : undefined;
            if (def && !known.has(id)) {
                parentPrompts.push(structuredClone(def));
                known.add(id);
            }
        }
        for (const a of drift.added) {
            if (!known.has(a.identifier)) {
                parentPrompts.push(structuredClone(a.definition));
                known.add(a.identifier);
            }
        }

        // 捕获回 profile 并持久化（副本事务；成功后 onMetaPersisted → syncPresetRegistrations 刷新注册记录）
        const meta = readMeta(parent);
        return await persistMetaTransaction(meta, (m) => {
            const profiles = Array.isArray(m.profiles) ? m.profiles : [];
            const target = profiles.find((p) => String(p.id) === String(marker.profileId));
            if (!target || (!isPromptBaseProfile(target) && !isPromptDeltaProfile(target))) return m;
            const next = applyPromptDriftToProfile(target, drift) as PromptBaseProfile | PromptDeltaProfile;
            if (top.sampling) next.sampling = top.sampling;
            if (top.extra) next.extra = top.extra;
            if (top.model) next.model = top.model;
            return { ...m, profiles: profiles.map((p) => (String(p.id) === String(marker.profileId) ? next as PresetProfile : p)) };
        }, marker.parentKey, parentIdx);
    } finally {
        capturing = false;
    }
}

/** 顶层键（采样/extra/模型等，排除 prompts/order/extensions/连接键）运行时与注册记录是否不同。
 * 只比较记录（已应用基线）中存在的键：运行态操作键（如 preset_settings_openai）不参与。 */
function topLevelKeysDiffer(runtime: Record<string, any>, record: Record<string, any>): boolean {
    const excluded = new Set(['prompts', 'prompt_order', 'extensions']);
    for (const key of Object.keys(record)) {
        if (excluded.has(key)) continue;
        const meta = settingsToUpdate[key];
        if (meta && meta[3]) continue; // is_connection 键不捕获
        if (runtime[key] !== record[key]) return true;
    }
    return false;
}

/** 采样/extra/模型漂移：相对「排除本 profile 的父链解析态」（base 相对出厂基线）。 */
function computeTopLevelDrift(
    parent: Preset,
    profileId: string,
    runtime: Record<string, any>,
): { sampling?: PromptSampling; extra?: Record<string, any>; model?: PromptModel } {
    const meta = readMeta(parent);
    const profiles = meta.profiles;
    const profile = getProfile(meta, profileId);
    if (!profile || (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile))) return {};
    const parentOf = isPromptDeltaProfile(profile)
        ? profiles.find((p) => String(p.id) === String(profile.baseId))
        : undefined;

    const out: { sampling?: PromptSampling; extra?: Record<string, any>; model?: PromptModel } = {};
    const sampling = diffSampling(
        captureSampling(runtime),
        parentOf ? resolveEffectiveSampling(parentOf, profiles, meta.defaultSampling) : meta.defaultSampling,
    );
    if (sampling && Object.keys(sampling).length > 0) out.sampling = sampling;

    const extra = diffExtra(
        captureExtra(runtime),
        parentOf ? resolveEffectiveExtra(parentOf, profiles, meta.defaultExtra) : meta.defaultExtra,
    );
    if (extra && Object.keys(extra).length > 0) out.extra = extra;

    const model = captureModel(runtime);
    const modelBase = parentOf ? resolveProfileModel(parentOf, profiles) : meta.defaultModel;
    if (model && (!modelBase || model.source !== modelBase.source || model.name !== modelBase.name)) {
        out.model = model;
    }
    return out;
}
