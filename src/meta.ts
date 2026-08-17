import { getRequestHeaders } from '@sillytavern/script';
import { t } from '@sillytavern/scripts/i18n';
import { openai_setting_names, openai_settings, oai_settings } from '@sillytavern/scripts/openai';
import { EXTENSION_KEY } from './constants.js';
import { L } from './i18n.js';
import type {
    PresetProfile,
    PromptDefaultSnapshotEntry,
    PromptModel,
    PromptSampling,
} from './core/domain/types.js';

// 领域类型与类型判别统一来自 core/domain（零 ST 依赖）。re-export 保持既有调用点不变。
export type {
    PromptBaseProfile,
    PromptDefaultSnapshotEntry,
    PromptDeltaChange,
    PromptDeltaProfile,
    PromptFields,
    PromptModel,
    PromptProfileEntry,
    PromptSampling,
    PromptStateChange,
    PresetProfile,
    ExtMountEntry,
    ExtProfileOverride,
} from './core/domain/types.js';

export { isPromptBaseProfile, isPromptDeltaProfile } from './core/domain/schema.js';

/** 预设对象的最小结构;其余字段是 ST 的任意设置,保持宽松。 */
export type Preset = Record<string, any> & {
    extensions?: Record<string, any>;
};

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
    /** 出厂模型基线：首次 add base 时锁定；reset 时把预设模型还原到出厂值。 */
    defaultModel?: PromptModel;
}

/** 按 id 查 profile（id 归一化为字符串，兼容数字/字符串来源）。 */
export function getProfile(meta: PresetMeta, profileId: unknown): PresetProfile | undefined {
    return meta.profiles.find((p) => String(p.id) === String(profileId));
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
        defaultModel: ext?.defaultModel && typeof ext.defaultModel === 'object' && !Array.isArray(ext.defaultModel)
            ? ext.defaultModel
            : undefined,
    };
}

/** 合并保存窗口（ms）：同一预设的多次保存合并为一次全量保存，避免高频操作逐次全量 POST。 */
const MERGE_WINDOW_MS = 300;

interface MergePending {
    presetIndex: number;
    meta: PresetMeta;
    timer: ReturnType<typeof setTimeout>;
    promise: Promise<void>;
}

/** per-preset 合并窗口内的待保存项（窗口内末次 meta 胜出）。 */
const mergePending = new Map<string, MergePending>();

/** per-preset 串行尾链：同一预设的落盘不并发（避免 last-write-wins 竞态）。 */
const tailByPreset = new Map<string, Promise<void>>();

/**
 * Persist metadata into the preset's extensions field and save to disk.
 * 统一机制：per-preset 合并窗口（窗口内末次 meta 胜出）+ per-preset 串行尾链。
 * 网络失败时 reject 给调用方（调用方决定回滚/提示），不阻塞后续保存。
 */
export function saveMeta(presetName: string, presetIndex: number, meta: PresetMeta): Promise<void> {
    const existing = mergePending.get(presetName);
    if (existing) {
        existing.meta = meta;
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
            const tail = tailByPreset.get(presetName) ?? Promise.resolve();
            const run = tail.then(async () => {
                await doSaveMeta(presetName, pending.presetIndex, pending.meta);
                // 注册链路同步钩子：任何 meta 落盘成功后通知（saveMeta 与 persistMetaTransaction
                // 统一在此触发——编辑器提交走 saveMetaMerged 也要对账注册；解耦避免循环依赖）
                for (const listener of [...metaPersistedListeners]) {
                    try {
                        listener(presetName, pending.presetIndex);
                    } catch (err) {
                        console.error('preset-cards: meta persisted listener failed', err);
                    }
                }
            });
            tailByPreset.set(presetName, run.then(() => undefined, () => undefined));
            run.then(resolveFn, rejectFn);
        }, MERGE_WINDOW_MS),
        promise,
    };
    mergePending.set(presetName, pending);
    return promise;
}

/** 历史别名：与 saveMeta 语义一致（合并窗口 + 串行尾链）。 */
export function saveMetaMerged(presetName: string, presetIndex: number, meta: PresetMeta): Promise<void> {
    return saveMeta(presetName, presetIndex, meta);
}

/** 统一「副本 → 变换 → 持久化 → 写回活 meta」事务：失败时不污染内存与磁盘，返回是否成功。
 * transform 不得修改传入的 meta（副本模式）；成功后 Object.assign 写回活 meta（保持对象身份）。
 * opts.toastMessage 指定失败提示文案（后台路径如保存捕获应给出明确归属的提示,而非通用预设保存失败）。 */
export async function persistMetaTransaction(
    meta: PresetMeta,
    transform: (m: PresetMeta) => PresetMeta,
    name: string,
    idx: number,
    opts?: { toastMessage?: string },
): Promise<boolean> {
    const nextMeta = transform(meta);
    try {
        await saveMeta(name, idx, nextMeta);
    } catch (err) {
        console.error('Persist preset metadata failed', err);
        toastr.error(opts?.toastMessage ?? L('Failed to save preset metadata'));
        return false;
    }
    Object.assign(meta, nextMeta);
    // 注册链路同步钩子已在 saveMeta 成功路径统一触发（本事务也走 saveMeta），此处不重复。
    return true;
}

/** profile 元数据持久化成功回调（注册链路用）。返回退订函数。 */
export type MetaPersistedListener = (name: string, idx: number) => void;
const metaPersistedListeners = new Set<MetaPersistedListener>();
export function onMetaPersisted(listener: MetaPersistedListener): () => void {
    metaPersistedListeners.add(listener);
    return () => { metaPersistedListeners.delete(listener); };
}

async function doSaveMeta(presetName: string, presetIndex: number, meta: PresetMeta): Promise<void> {
    const preset = openai_settings[presetIndex] as Preset | undefined;
    if (!preset) return;
    // 合并窗口延迟落盘：预设若在窗口内被删除（openai_setting_names 已移除），放弃本次落盘，
    // 避免用旧 body 把已删除的预设重新创建到服务器（删除与延迟保存的竞态）。
    if (openai_setting_names[presetName] === undefined) return;

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
        defaultModel: meta.defaultModel,
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
