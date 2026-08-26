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
    /** 合并窗口打开时的目标对象身份；名称映射/数组槽变化时拒绝，绝不写到替换后的同名对象。 */
    target: Preset;
    meta: PresetMeta;
    /** 随本次 meta 一并落盘的预设本体补丁（如采样字段）；窗口内按字段合并，extensions 递归合并。 */
    patch?: Record<string, any>;
    timer: ReturnType<typeof setTimeout>;
    promise: Promise<void>;
}

/** per-preset 合并窗口内的待保存项（窗口内末次 meta 胜出）。 */
const mergePending = new Map<string, MergePending>();

/** per-preset 串行尾链：同一预设的落盘不并发（避免 last-write-wins 竞态）。 */
const tailByPreset = new Map<string, Promise<void>>();

function isPlainRecord(value: unknown): value is Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 合并同一保存窗口的本体 patch：后写字段胜出；普通对象递归合并；数组作为完整值替换。 */
function mergePresetPatch(
    previous: Record<string, any> | undefined,
    next: Record<string, any> | undefined,
): Record<string, any> | undefined {
    if (!next) return previous;
    const merged = previous ? structuredClone(previous) : {};
    for (const [key, value] of Object.entries(next)) {
        const prior = merged[key];
        merged[key] = isPlainRecord(prior) && isPlainRecord(value)
            ? mergePresetPatch(prior, value)
            : structuredClone(value);
    }
    return merged;
}

/**
 * Persist metadata into the preset's extensions field and save to disk.
 * 统一机制：per-preset 合并窗口（窗口内末次 meta 胜出）+ per-preset 串行尾链。
 * 网络失败时 reject 给调用方（调用方决定回滚/提示），不阻塞后续保存。
 */
export function saveMeta(presetName: string, presetIndex: number, meta: PresetMeta, patch?: Record<string, any>): Promise<void> {
    const target = openai_settings[presetIndex] as Preset | undefined;
    if (!target || openai_setting_names[presetName] !== presetIndex) {
        return Promise.reject(new Error('Preset target changed before save'));
    }
    const existing = mergePending.get(presetName);
    if (existing) {
        if (existing.presetIndex !== presetIndex || existing.target !== target) {
            return Promise.reject(new Error('Preset target changed before save'));
        }
        existing.meta = meta;
        existing.patch = mergePresetPatch(existing.patch, patch);
        return existing.promise;
    }
    let resolveFn!: () => void;
    let rejectFn!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolveFn = res; rejectFn = rej; });
    const pending: MergePending = {
        presetIndex,
        target,
        meta,
        patch: mergePresetPatch(undefined, patch),
        timer: setTimeout(() => {
            mergePending.delete(presetName);
            const tail = tailByPreset.get(presetName) ?? Promise.resolve();
            const run = tail.then(async () => {
                await doSaveMeta(presetName, pending.presetIndex, pending.target, pending.meta, pending.patch);
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
    opts?: { toastMessage?: string; patch?: Record<string, any> },
): Promise<boolean> {
    const nextMeta = transform(meta);
    try {
        await saveMeta(name, idx, nextMeta, opts?.patch);
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

async function doSaveMeta(
    presetName: string,
    presetIndex: number,
    target: Preset,
    meta: PresetMeta,
    patch?: Record<string, any>,
): Promise<void> {
    const currentIndex = openai_setting_names[presetName];
    const preset = openai_settings[presetIndex] as Preset | undefined;
    // 延迟窗口内删除、同名替换、数组槽位漂移都必须显式失败：调用方据此回滚/报错，
    // 不能把旧目标内容写入新对象，也不能把 no-op 当成保存成功。
    if (currentIndex !== presetIndex || !preset || preset !== target) {
        throw new Error('Preset target changed before save');
    }
    // 副本先行：新 meta 与本体补丁只进请求体，/api/presets/save 成功后才写回活对象——
    // 失败（网络错误 / 非 ok 响应）时内存与磁盘都保持原状，「失败不污染」对 extensions
    // 与 patch 字段同时成立。
    const presetBody = structuredClone(preset);
    if (patch) Object.assign(presetBody, patch); // 补丁先行：插件元数据容器始终以本次 transform 为准（补丁可能整体携带旧 extensions 克隆）
    if (!presetBody.extensions) presetBody.extensions = {};
    presetBody.extensions[EXTENSION_KEY] = {
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

    // 成功：请求体内容写回活对象（保持引用身份），活动预设同步完整 extensions 镜像。
    if (patch) Object.assign(preset, patch); // 与请求体同序：先补丁后容器覆写
    if (!preset.extensions) preset.extensions = {};
    preset.extensions[EXTENSION_KEY] = presetBody.extensions[EXTENSION_KEY];
    if (oai_settings.preset_settings_openai === presetName) {
        // 原生保存会从 oai_settings 读取完整 extensions；只镜像 preset_cards 会让正则等 patch
        // 在下一次原生保存时被旧运行时值覆盖回去。
        oai_settings.extensions = structuredClone(preset.extensions);
    }
}
