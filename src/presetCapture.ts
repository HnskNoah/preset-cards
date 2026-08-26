// presetCapture：切片 3 保存捕获（SETTINGS_UPDATED → 原生编辑自动吸收进 profile）。
// 门：仅当活动预设是注册 profile（marker kind='profile'）时执行；
// diff 运行时（oai_settings）vs 注册记录 → 捕获回 profile delta + 材料留池/新增入父池 +
// 刷新注册记录（onMetaPersisted → sync 自动完成）。无漂移时零写入（防重入）。
import { eventSource, event_types } from '@sillytavern/scripts/events';
import { openai_settings, openai_setting_names, oai_settings, settingsToUpdate } from '@sillytavern/scripts/openai';
import { getProfile, isPromptBaseProfile, isPromptDeltaProfile, persistMetaTransaction, readMeta } from './meta.js';
import type { Preset, PresetProfile, PromptBaseProfile, PromptDeltaProfile, PromptModel, PromptSampling } from './meta.js';
import { resolvePromptOrderTarget } from './promptOrder.js';
import { L } from './i18n.js';
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
import { computeExtensionDrift } from './extCapture.js';
import { buildInheritedExtensionBaseline } from './extApply.js';
import { collectProfileChain } from './promptApply.js';
import { stableStringify } from './stableStringify.js';

/** 捕获周期状态：进行中标记 + 待重跑标记（持久化窗口内被挡的 SETTINGS_UPDATED 不丢事件，
 * 落盘后重跑一轮——否则窗口内的用户编辑会被 refreshProjectionRuntimeIfActive 的旧时点记录覆盖丢失）。 */
let captureBusy = false;
let rerunPending = false;
let settleWaiters: (() => void)[] = [];

/** 捕获周期（含全部待重跑轮次）落定后 resolve；refreshProjectionRuntimeIfActive 等它后再重应用运行时。 */
export function whenCaptureSettled(): Promise<void> {
    if (!captureBusy && !rerunPending) return Promise.resolve();
    return new Promise((resolve) => settleWaiters.push(resolve));
}

function notifySettled(): void {
    const waiters = settleWaiters;
    settleWaiters = [];
    for (const w of waiters) w();
}

/** 捕获成功且发生了变更后的通知（UI 刷新用：卡片页订阅后重渲染，避免显示删除前旧状态）。 */
type CaptureAppliedListener = () => void;
const captureAppliedListeners = new Set<CaptureAppliedListener>();
export function onCaptureApplied(listener: CaptureAppliedListener): () => void {
    captureAppliedListeners.add(listener);
    return () => { captureAppliedListeners.delete(listener); };
}

async function runCaptureCycle(): Promise<void> {
    captureBusy = true;
    try {
        const changed = await captureIfRegistered();
        if (changed) {
            for (const listener of [...captureAppliedListeners]) {
                try {
                    listener();
                } catch (err) {
                    console.error('preset-cards: capture applied listener failed', err);
                }
            }
        }
    } catch (err) {
        console.error('preset-cards: capture failed', err);
    } finally {
        captureBusy = false;
        if (rerunPending) {
            rerunPending = false;
            void runCaptureCycle(); // settle 推迟到重跑轮结束（重跑也可能再落盘触发级联）
            return;
        }
        notifySettled();
    }
}

/** 初始化保存捕获：监听 SETTINGS_UPDATED（ST 保存落盘成功后触发；原生 PM 每次编辑都以它收尾）。init.ts 调用。 */
export function initPresetCapture(): void {
    eventSource.on(event_types.SETTINGS_UPDATED, () => {
        if (captureBusy) {
            rerunPending = true; // 捕获持久化窗口内的编辑不丢：落盘后重跑
            return;
        }
        void runCaptureCycle();
    });
}

/** 门 + 捕获：活动预设是注册 profile 时，把运行时漂移捕获回 profile。返回是否发生变更（含持久化成功）。
 * 调用方：runCaptureCycle（事件周期，串行 + 待重跑）；测试/适配层可直接单发调用。 */
export async function captureIfRegistered(): Promise<boolean> {
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
    const hasPromptBaseline = Array.isArray(record.prompts) && record.prompts.length > 0;
    const drift = hasPromptBaseline ? computePromptDrift(oai_settings as any, record, resolvePromptOrderTarget()) : undefined;
    const top = computeTopLevelDrift(parent, marker.profileId, oai_settings as any, record);
    const meta = readMeta(parent);
    const currentProfile = getProfile(meta, marker.profileId);
    const currentExt = currentProfile && (isPromptBaseProfile(currentProfile) || isPromptDeltaProfile(currentProfile))
        ? currentProfile.extProfile
        : undefined;
    // 扩展漂移对照「继承基线」= 父预设 ⊕ 祖先层 extProfile：应用沿链重放，捕获必须同基线对齐——
    // 否则祖先挂载条目的编辑会被记成后代重复 mount 且永不重放、删除则完全不可捕获（下次激活复活）。
    let extBaselineParent: Record<string, any> = parent as Record<string, any>;
    if (currentProfile && (isPromptBaseProfile(currentProfile) || isPromptDeltaProfile(currentProfile))) {
        const ancestors = collectProfileChain(
            currentProfile,
            meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[],
        ).slice(0, -1);
        if (ancestors.some((a) => a.extProfile)) {
            extBaselineParent = buildInheritedExtensionBaseline(parent as Record<string, any>, ancestors);
        }
    }
    const extDrift = computeExtensionDrift(oai_settings as any, extBaselineParent);
    // 扩展净零：漂移与 profile 现有 extProfile 稳定序列化等价 → 无变化（防每次 SETTINGS_UPDATED 全量落盘）
    const extUnchanged = extDrift === null
        ? currentExt === undefined // 无漂移且原本无覆盖 → 无事；原本有覆盖则需落盘删除
        : currentExt !== undefined && stableStringify(extDrift) === stableStringify(currentExt);
    const hasPromptDrift = drift !== undefined && !isEmptyPromptDrift(drift);
    if (!hasPromptDrift && Object.keys(top).length === 0 && extUnchanged) return false;

    // 材料恢复（池删除）/ 新增入父池：dormant prompt 定义进父预设 prompts[]（不挂载，仅池）。
    // ST 摘除（unmounted）的 prompt 池仍在，无需恢复。
    if (hasPromptDrift && drift) {
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
    }

    // 捕获回 profile 并持久化（副本事务；成功后 onMetaPersisted → syncPresetRegistrations 刷新注册记录）。
    // toastMessage：失败时明确告知是「配置捕获同步」失败(而非用户在操作的功能报错)
    return await persistMetaTransaction(meta, (m) => {
        const profiles = Array.isArray(m.profiles) ? m.profiles : [];
        const target = profiles.find((p) => String(p.id) === String(marker.profileId));
        if (!target || (!isPromptBaseProfile(target) && !isPromptDeltaProfile(target))) return m;
        const next = applyPromptDriftToProfile(target, drift ?? {
            changedFields: [],
            enabledChanges: [],
            order: undefined,
            deleted: [],
            unmounted: [],
            remounted: [],
            added: [],
        }) as PromptBaseProfile | PromptDeltaProfile;
        if (Object.hasOwn(top, 'sampling')) {
            if (top.sampling) next.sampling = top.sampling;
            else delete next.sampling;
        }
        if (Object.hasOwn(top, 'extra')) {
            if (top.extra) next.extra = top.extra;
            else delete next.extra;
        }
        if (Object.hasOwn(top, 'model')) {
            if (top.model) next.model = top.model;
            else delete next.model;
        }
        // 扩展覆盖（mount/unmount/toggle）：有变化时写入，无变化时清除
        if (extDrift) {
            (next as any).extProfile = extDrift;
        } else {
            delete (next as any).extProfile;
        }
        return { ...m, profiles: profiles.map((p) => (String(p.id) === String(marker.profileId) ? next as PresetProfile : p)) };
    }, marker.parentKey, parentIdx, { toastMessage: L('Failed to sync captured profile changes') });
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

function samplingKeysDiffer(runtime: Record<string, any>, record: Record<string, any>): boolean {
    for (const presetKey of SAMPLING_KEYS) {
        if (!Object.hasOwn(record, presetKey)) continue;
        const settingsKey = settingsToUpdate[presetKey]?.[1] ?? presetKey;
        if (runtime[settingsKey] !== record[presetKey]) return true;
    }
    return false;
}

function extraKeysDiffer(runtime: Record<string, any>, record: Record<string, any>): boolean {
    for (const presetKey of Object.keys(record)) {
        if (SAMPLING_KEYS.some((key) => key === presetKey)) continue;
        if (EXTRA_EXCLUDED_KEYS.has(presetKey)) continue;
        const setting = settingsToUpdate[presetKey];
        if (setting?.[3]) continue;
        const settingsKey = setting?.[1] ?? presetKey;
        if (runtime[settingsKey] !== record[presetKey]) return true;
    }
    return false;
}

function modelsEqual(a: PromptModel | null | undefined, b: PromptModel | null | undefined): boolean {
    return a?.source === b?.source && a?.name === b?.name;
}

type TopLevelDrift = {
    sampling?: PromptSampling | null;
    extra?: Record<string, any> | null;
    model?: PromptModel | null;
};

/** 采样/extra/模型漂移：先按类别确认运行时相对注册记录确有变化，再与当前 profile 和父级基线比较。
 * null 表示用户已回到继承基线，持久化时必须删除当前 profile 的对应 override。 */
function computeTopLevelDrift(
    parent: Preset,
    profileId: string,
    runtime: Record<string, any>,
    record: Record<string, any>,
): TopLevelDrift {
    const meta = readMeta(parent);
    const profiles = meta.profiles;
    const profile = getProfile(meta, profileId);
    if (!profile || (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile))) return {};
    const parentOf = isPromptDeltaProfile(profile)
        ? profiles.find((p) => String(p.id) === String(profile.baseId))
        : undefined;
    const baselineSampling = parentOf ? resolveEffectiveSampling(parentOf, profiles, meta.defaultSampling) : meta.defaultSampling;
    const baselineExtra = parentOf ? resolveEffectiveExtra(parentOf, profiles, meta.defaultExtra) : meta.defaultExtra;
    const baselineModel = parentOf
        ? resolveProfileModel(parentOf, profiles) ?? meta.defaultModel
        : meta.defaultModel;

    const out: TopLevelDrift = {};
    if (samplingKeysDiffer(runtime, record)) {
        const captured = runtimeSampling(runtime);
        const current = resolveEffectiveSampling(profile, profiles, meta.defaultSampling);
        const changed = diffSampling(captured, current);
        if (changed && Object.keys(changed).length > 0) {
            out.sampling = diffSampling(captured, baselineSampling);
        }
    }

    if (extraKeysDiffer(runtime, record)) {
        const captured = runtimeExtra(runtime);
        const current = resolveEffectiveExtra(profile, profiles, meta.defaultExtra);
        const changed = diffExtra(captured, current);
        if (changed && Object.keys(changed).length > 0) {
            out.extra = diffExtra(captured, baselineExtra);
        }
    }

    const capturedModel = captureModel(runtime);
    const recordModel = captureModel(record);
    if (capturedModel && !modelsEqual(capturedModel, recordModel)) {
        const currentModel = resolveProfileModel(profile, profiles) ?? meta.defaultModel;
        if (!modelsEqual(capturedModel, currentModel)) {
            out.model = modelsEqual(capturedModel, baselineModel) ? null : capturedModel;
        }
    }
    return out;
}
