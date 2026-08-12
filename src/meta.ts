import { getRequestHeaders } from '@sillytavern/script';
import { t } from '@sillytavern/scripts/i18n';
import { openai_settings, oai_settings } from '@sillytavern/scripts/openai';
import { EXTENSION_KEY } from './constants.js';
import { isV3BaseProfileData, isV3DeltaProfileData } from './profileSchema.js';

/** 预设对象的最小结构;其余字段是 ST 的任意设置,保持宽松。 */
export type Preset = Record<string, any> & {
    extensions?: Record<string, any>;
};

export interface PresetProfileV1 {
    id: string;
    name: string;
    settings: Record<string, any>;
    formatVersion?: 1;
}

/** prompt 值字段（全可选，向后兼容旧数据）。白名单见 PROMPT_FIELD_WHITELIST。 */
export interface PromptFields {
    content?: string;
    name?: string;
    role?: string;
    injection_position?: number;
    injection_depth?: number;
}

/** 采样参数快照（全可选）：缺失的键在加载 profile 时保持预设当前值，不覆盖。
 * 键与 SAMPLING_KEYS 一一对应（temperature/top_p/top_k/top_a/min_p/frequency_penalty/
 * presence_penalty/repetition_penalty/seed/n/openai_max_context/openai_max_tokens/stream_openai）。 */
export interface PromptSampling {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    top_a?: number;
    min_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    repetition_penalty?: number;
    seed?: number;
    n?: number;
    openai_max_context?: number;
    openai_max_tokens?: number;
    stream_openai?: boolean;
}

/** v3 prompt 条目：挂载态（mounted）+ 开关 + 值字段差异。 */
export interface PromptProfileEntry {
    identifier: string;
    mounted: boolean;
    enabled: boolean;
    lastActiveIndex?: number;
    fields?: PromptFields;
}

/** v3 delta 的一条差异：挂载/开关/顺序/值字段差异。 */
export interface PromptStateChange {
    identifier: string;
    mounted?: boolean;
    enabled?: boolean;
    lastActiveIndex?: number;
    fields?: PromptFields;
}

/** 主 profile（formatVersion 3）：记录当前目标 prompt_order 的完整挂载状态 + 值字段。
 * 是 v2（formatVersion 2）的超集：v2 数据仅记录 mounted 开关，v3 增补 unused/顺序。 */
export interface PromptBaseProfile {
    formatVersion: 3;
    kind: 'prompt_base';
    id: string;
    name: string;
    prompts: PromptProfileEntry[];
    /** 保存时未挂载（在 prompts 定义中但不在目标 prompt_order）的 identifier。只记 id，不存无意义字段。 */
    unusedIds?: string[];
    /** 导入存档 base 标记：只读、隐藏、作为 reset 相对基线。最后一个子节点删除时级联删除。 */
    archive?: true;
    /** 采样参数快照（可选）：仅存「相对出厂基线有差异」的键；加载时存在键覆盖，缺失键不动。 */
    sampling?: PromptSampling;
    /** 附加快照（可选）：仅存「相对出厂基线有差异」的预设键（如 impersonation_prompt、bias_preset_selected 等）。
     * 加载时 Object.assign 还原到预设（保留 extensions）。缺失键不动。 */
    extra?: Record<string, any>;
}

/** 派生 profile 的一条差异：挂载/开关/顺序/值字段差异（与 PromptStateChange 同构的兼容别名）。
 * v3 下 delta 的 changes 实际为 PromptStateChange[]（含 mounted/lastActiveIndex），
 * 此类型用于兼容既有 PromptDeltaChange[] 调用点。 */
export interface PromptDeltaChange {
    identifier: string;
    mounted?: boolean;
    enabled?: boolean;
    lastActiveIndex?: number;
    fields?: Record<string, any>;
}

/** 派生 profile（formatVersion 3）：相对主 profile 的差异，加载时「主 + 子」叠加应用。 */
export interface PromptDeltaProfile {
    formatVersion: 3;
    kind: 'prompt_delta';
    id: string;
    name: string;
    baseId: string;
    changes: PromptStateChange[];
    /** 完整的 mounted identifier 顺序；缺省表示继承父级顺序。 */
    order?: string[];
    /** 采样参数快照（可选）：仅存差异键；加载时存在键覆盖，缺失键不动。 */
    sampling?: PromptSampling;
    /** 附加快照（可选）：同 PromptBaseProfile.extra，仅存差异键。 */
    extra?: Record<string, any>;
}

/** defaultSnapshot 条目：出厂基线（首次 add base 时锁定）。挂载态 + 开关 + 原始值字段。 */
export interface PromptDefaultSnapshotEntry {
    identifier: string;
    mounted: boolean;
    enabled: boolean;
    lastActiveIndex?: number;
    originalFields?: PromptFields;
}

export type PresetProfile = PresetProfileV1 | PromptBaseProfile | PromptDeltaProfile;

export function isPromptBaseProfile(profile: PresetProfile): profile is PromptBaseProfile {
    return isV3BaseProfileData(profile);
}

export function isPromptDeltaProfile(profile: PresetProfile): profile is PromptDeltaProfile {
    return isV3DeltaProfileData(profile);
}

export interface PresetMeta {
    description: string;
    models: string[];
    profiles: PresetProfile[];
    bgImage: string;
    /** 隐藏默认基准：自动维护，不显示、不参与派生。供重置回退。 */
    defaultSnapshot?: PromptDefaultSnapshotEntry[];
    /** 默认基准是否已全量锁定（区分旧版仅开关快照与新版含 originalFields 的全量基线）。 */
    defaultSnapshotLocked?: boolean;
    /** 出厂采样基线：首次 add base 时与 defaultSnapshot 一起锁定；reset 时把预设采样键还原到出厂值。 */
    defaultSampling?: PromptSampling;
    /** 出厂 extra 基线：首次 add base 时与 defaultSnapshot 一起锁定；reset 时把预设的 extra 键还原到出厂值。 */
    defaultExtra?: Record<string, any>;
    /** 导入存档 base 的 id（只读隐藏 base）。该 base 的最后一个子节点删除时级联删除。 */
    archiveBaseId?: string;
}

/** 按 id 查 profile（id 归一化为字符串，兼容数字/字符串来源）。 */
export function getProfile(meta: PresetMeta, profileId: unknown): PresetProfile | undefined {
    return meta.profiles.find((p) => p.id === String(profileId));
}

/** 生成新的 profile id（时间戳 + 随机后缀）。 */
export function newProfileId(): string {
    return Date.now().toString() + Math.floor(Math.random() * 1000);
}

/**
 * Read the preset_cards metadata from a preset object.
 */
export function readMeta(preset: Preset | undefined): PresetMeta {
    const ext = preset?.extensions?.[EXTENSION_KEY];
    return {
        description: ext?.description || '',
        models: Array.isArray(ext?.models) ? ext.models : [],
        profiles: Array.isArray(ext?.profiles) ? ext.profiles : [],
        bgImage: ext?.bgImage || '',
        defaultSnapshot: Array.isArray(ext?.defaultSnapshot) ? ext.defaultSnapshot : undefined,
        defaultSnapshotLocked: ext?.defaultSnapshotLocked === true,
        defaultSampling: ext?.defaultSampling && typeof ext.defaultSampling === 'object' && !Array.isArray(ext.defaultSampling)
            ? ext.defaultSampling
            : undefined,
        defaultExtra: ext?.defaultExtra && typeof ext.defaultExtra === 'object' && !Array.isArray(ext.defaultExtra)
            ? ext.defaultExtra
            : undefined,
        archiveBaseId: typeof ext?.archiveBaseId === 'string' ? ext.archiveBaseId : undefined,
    };
}

/** 模块级保存串行链：同一时刻仅一个 saveMeta 在飞，避免并发 POST 全量预设造成 last-write-wins 丢更新。 */
let saveChain: Promise<void> = Promise.resolve();

/**
 * Persist metadata into the preset's extensions field and save to disk.
 * 串行执行：每次保存排队在前一次之后，网络失败时抛错（调用方决定回滚/提示）。
 */
export function saveMeta(presetName: string, presetIndex: number, meta: PresetMeta): Promise<void> {
    // 失败也继续链（reject 传给调用方，但链不阻塞后续保存）
    saveChain = saveChain.then(
        () => doSaveMeta(presetName, presetIndex, meta),
        () => doSaveMeta(presetName, presetIndex, meta),
    );
    return saveChain;
}

/** 合并保存窗口（ms）：同一预设的合并保存延迟到窗口结束执行一次全量保存，避免高频操作逐次全量 POST。 */
const MERGE_WINDOW_MS = 300;

interface MergePending {
    presetIndex: number;
    meta: PresetMeta;
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
    reject: (e: unknown) => void;
    promise: Promise<void>;
}

const mergePending = new Map<string, MergePending>();

/** 合并保存：同一预设名在窗口内的多次保存合并为一次（保留最新 meta），窗口结束才真正落盘。
 * 失败语义与 saveMeta 一致（reject 给调用方）；窗口内后续调用复用同一个 promise。 */
export function saveMetaMerged(presetName: string, presetIndex: number, meta: PresetMeta): Promise<void> {
    const existing = mergePending.get(presetName);
    if (existing) {
        existing.meta = meta; // 保留最新 meta，延后到原 timer 触发
        return existing.promise;
    }
    let resolveFn!: () => void;
    let rejectFn!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolveFn = res; rejectFn = rej; });
    const pending: MergePending = {
        presetIndex,
        meta,
        timer: setTimeout(() => {
            mergePending.delete(presetName);
            saveMeta(presetName, pending.presetIndex, pending.meta).then(resolveFn, rejectFn);
        }, MERGE_WINDOW_MS),
        resolve: resolveFn,
        reject: rejectFn,
        promise,
    };
    mergePending.set(presetName, pending);
    return promise;
}

async function doSaveMeta(presetName: string, presetIndex: number, meta: PresetMeta): Promise<void> {
    const preset = openai_settings[presetIndex] as Preset | undefined;
    if (!preset) return;

    // Ensure extensions object exists
    if (!preset.extensions) preset.extensions = {};
    preset.extensions[EXTENSION_KEY] = {
        description: meta.description || '',
        models: meta.models || [],
        profiles: meta.profiles || [],
        bgImage: meta.bgImage || '',
        defaultSnapshot: meta.defaultSnapshot,
        defaultSnapshotLocked: meta.defaultSnapshotLocked === true,
        defaultSampling: meta.defaultSampling,
        defaultExtra: meta.defaultExtra,
        archiveBaseId: meta.archiveBaseId,
    };

    // Also update oai_settings if this is the current preset
    if (oai_settings.preset_settings_openai === presetName) {
        if (!oai_settings.extensions) oai_settings.extensions = {};
        oai_settings.extensions[EXTENSION_KEY] = preset.extensions[EXTENSION_KEY];
    }

    // Build the preset body from the actual preset object (not from oai_settings,
    // which reflects the *currently active* preset — possibly a different one).
    const presetBody = structuredClone(preset);

    const response = await fetch('/api/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            apiId: 'openai',
            name: presetName,
            preset: presetBody,
        }),
    });

    if (!response.ok) {
        toastr.error(t`Failed to save preset metadata`);
        console.error('Failed to save preset metadata', response);
        throw new Error('Failed to save preset metadata');
    }
}
