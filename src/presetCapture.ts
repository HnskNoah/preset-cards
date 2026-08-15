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
    captureModel,
    diffExtra,
    diffSampling,
    resolveEffectiveExtra,
    resolveEffectiveSampling,
    resolveProfileModel,
    EXTRA_EXCLUDED_KEYS,
} from './promptToggle.js';
import { SAMPLING_KEYS } from './constants.js';

/** 防重入：捕获期间再次 SETTINGS_UPDATED 直接跳过（等待本次落盘后再对账）。 */
let capturing = false;

/** 捕获成功且发生了变更后的通知（UI 刷新用：卡片页订阅后重渲染，避免显示删除前旧状态）。 */
type CaptureAppliedListener = () => void;
const captureAppliedListeners = new Set<CaptureAppliedListener>();
export function onCaptureApplied(listener: CaptureAppliedListener): () => void {
    captureAppliedListeners.add(listener);
    return () => { captureAppliedListeners.delete(listener); };
}

/** 初始化保存捕获：监听 SETTINGS_UPDATED（ST 保存落盘成功后触发；原生 PM 每次编辑都以它收尾）。init.ts 调用。 */
export function initPresetCapture(): void {
    eventSource.on(event_types.SETTINGS_UPDATED, () => {
        void captureIfRegistered()
            .then((changed) => {
                if (!changed) return;
                for (const listener of [...captureAppliedListeners]) {
                    try {
                        listener();
                    } catch (err) {
                        console.error('preset-cards: capture applied listener failed', err);
                    }
                }
            })
            .catch((err) => console.error('preset-cards: capture failed', err));
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
    // 无基线守卫：注册记录无 prompts（父预设缺 prompts → 投影无 → PM 重建默认）时跳过 prompt 漂移,
    // 避免把全部运行时默认 prompt 判为 added 全量写进 profile 并灌入父池（C6）
    if (!Array.isArray(record.prompts) || record.prompts.length === 0) return false;

    capturing = true;
    try {
        const drift = computePromptDrift(oai_settings as any, record);
        // 顶层（采样/extra/模型）漂移：仅当「运行时 vs 注册记录」确有差异才计算 v3 diff
        const top = topLevelKeysDiffer(oai_settings as any, record)
            ? computeTopLevelDrift(parent, marker.profileId, oai_settings as any)
            : {};
        if (isEmptyPromptDrift(drift) && Object.keys(top).length === 0) return false;

        // 材料恢复（池删除）/ 新增入父池：dormant prompt 定义进父预设 prompts[]（不挂载，仅池）。
        // ST 摘除（unmounted）的 prompt 池仍在，无需恢复。
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
 * 只比较记录（已应用基线）中存在的键；ST 预设键名 ≠ 设置键名（temperature→temp_openai 等,
 * settingsToUpdate 映射），运行时按设置键取值比较（NEW-1：否则恒真 → 首次捕获把整个运行时
 * 快照灌进 profile.extra）。 */
function topLevelKeysDiffer(runtime: Record<string, any>, record: Record<string, any>): boolean {
    const excluded = new Set(['prompts', 'prompt_order', 'extensions']);
    for (const presetKey of Object.keys(record)) {
        if (excluded.has(presetKey)) continue;
        const meta = settingsToUpdate[presetKey];
        if (meta && meta[3]) continue; // is_connection 键不捕获
        const settingsKey = meta ? meta[1] : presetKey;
        if (runtime[settingsKey] !== record[presetKey]) return true;
    }
    return false;
}

/** 从运行时（设置键空间）采集采样快照，键名转回预设键空间（profile 采样存预设键）。 */
function runtimeSampling(runtime: Record<string, any>): PromptSampling | null {
    const out: PromptSampling = {};
    for (const presetKey of SAMPLING_KEYS) {
        const meta = settingsToUpdate[presetKey];
        const settingsKey = meta ? meta[1] : presetKey;
        const value = runtime[settingsKey];
        if (value !== undefined) (out as Record<string, unknown>)[presetKey] = value;
    }
    return Object.keys(out).length > 0 ? out : null;
}

/** 运行时 extras：排除「预设键≠设置键」的设置键（如 temp_openai，由 sampling/映射处理），
 * 避免把设置键名当 extra 键灌进 profile。 */
function runtimeExtra(runtime: Record<string, any>): Record<string, any> | null {
    const settingsKeysDiffering = new Set(
        Object.entries(settingsToUpdate)
            .filter(([presetKey, meta]) => meta[1] !== presetKey)
            .map(([, meta]) => meta[1]),
    );
    const extra: Record<string, any> = {};
    for (const [key, value] of Object.entries(runtime)) {
        if (SAMPLING_KEYS.some((k) => k === key)) continue;
        if (settingsKeysDiffering.has(key)) continue;
        if (EXTRA_EXCLUDED_KEYS.has(key)) continue;
        extra[key] = value;
    }
    return Object.keys(extra).length > 0 ? extra : null;
}

/** 采样/extra/模型漂移：判定用「运行时 vs profile 当前生效值」（变了才算），
 * 存储用 v3 diff（相对排除本 profile 的父链基线，base 相对出厂基线）。 */
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
    const baselineSampling = parentOf ? resolveEffectiveSampling(parentOf, profiles, meta.defaultSampling) : meta.defaultSampling;
    const baselineExtra = parentOf ? resolveEffectiveExtra(parentOf, profiles, meta.defaultExtra) : meta.defaultExtra;

    const out: { sampling?: PromptSampling; extra?: Record<string, any>; model?: PromptModel } = {};
    // 判定：运行时 vs profile 当前生效值（变了才算；键空间用运行时采样/extra 转换）
    const currentSampling = resolveEffectiveSampling(profile, profiles, meta.defaultSampling);
    const samplingDiff = diffSampling(runtimeSampling(runtime), currentSampling);
    if (samplingDiff && Object.keys(samplingDiff).length > 0) {
        out.sampling = diffSampling(runtimeSampling(runtime), baselineSampling) ?? undefined;
    }
    const currentExtra = resolveEffectiveExtra(profile, profiles, meta.defaultExtra);
    const extraDiff = diffExtra(runtimeExtra(runtime), currentExtra);
    if (extraDiff && Object.keys(extraDiff).length > 0) {
        out.extra = diffExtra(runtimeExtra(runtime), baselineExtra) ?? undefined;
    }
    const model = captureModel(runtime);
    const currentModel = resolveProfileModel(profile, profiles);
    if (model && (!currentModel || model.source !== currentModel.source || model.name !== currentModel.name)) {
        out.model = model;
    }
    return out;
}
