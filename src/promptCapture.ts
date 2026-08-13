import { oai_settings, settingsToUpdate } from '@sillytavern/scripts/openai';
import { PROMPT_FIELD_KEYS } from './profileSchema.js';
import type { Preset, PromptFields, PromptModel, PromptSampling } from './meta.js';
import { MODEL_KEYS, SAMPLING_KEYS } from './constants.js';

/** 允许写入预设的值字段白名单；capture/apply 只处理这些键（R10 白名单兜底）。
 * injection_position / injection_depth 为用户可编辑字段，随 profile 捕获/应用
 * （injection_depth 支持 profile-editor 弹窗的注入深度编辑）；
 * order 仍为内部字段，UI 不编辑、不随 profile 捕获，
 * 否则加载 profile 时会用旧快照覆盖用户此后在 Prompt Manager 里调整的注入值。 */
export const PROMPT_FIELD_WHITELIST: (keyof PromptFields)[] = [...PROMPT_FIELD_KEYS];

/** 两个 PromptFields 是否逐白名单字段一致（用于判断编辑是否有净变化）。 */
export function promptFieldsEqual(a: PromptFields, b: PromptFields): boolean {
    return PROMPT_FIELD_WHITELIST.every((key) => a[key] === b[key]);
}

/** 采集预设当前的采样参数快照（SAMPLING_KEYS 全部键，值非 undefined 才写入）；无任何键时返回 null。
 * 返回 null 而非空对象，便于调用点统一「非空才持久化 sampling」（避免落盘 sampling:{} 噪声）。 */
export function captureSampling(preset: Preset): PromptSampling | null {
    const sampling: PromptSampling = {};
    for (const key of SAMPLING_KEYS) {
        const value = (preset as Record<string, unknown>)[key];
        if (value !== undefined) {
            (sampling as Record<string, unknown>)[key] = value;
        }
    }
    return Object.keys(sampling).length > 0 ? sampling : null;
}

/** 采集预设当前绑定的模型快照（source + MODEL_KEYS 对应模型名）。仅记录展示用，加载 profile 时应用。 */
export function captureModel(preset: Preset): PromptModel | null {
    const source = String(preset['chat_completion_source'] ?? '');
    if (!source) return null;
    const modelKey = MODEL_KEYS[source];
    if (!modelKey) return null;
    const name = String(preset[modelKey] ?? '');
    return name ? { source, name } : null;
}

/** 应用模型快照到预设：写 chat_completion_source 与对应模型键（仅当快照存在）。 */
export function applyModel(preset: Preset, model: PromptModel): void {
    if (!model || !model.source || !model.name) return;
    const target = preset as Record<string, unknown>;
    target['chat_completion_source'] = model.source;
    const modelKey = MODEL_KEYS[model.source];
    if (modelKey) target[modelKey] = model.name;
}

/** 应用采样参数快照到预设：只写 sampling 中存在的键，缺失键保持预设当前值（不动）。 */
export function applySampling(preset: Preset, sampling: PromptSampling): void {
    const target = preset as Record<string, unknown>;
    for (const key of SAMPLING_KEYS) {
        const value = (sampling as Record<string, unknown>)[key];
        if (value !== undefined) target[key] = value;
    }
}

/** 采样键与忽略键之外、应排除出 extra 快照的键（prompt 主体在 prompts 数组/order 处理）。
 * 连接/凭据键（ST settingsToUpdate 标记 is_connection=true：模型、来源、代理、endpoint 等）一律排除——
 * 它们是「用户当前连接状态」而非 profile 快照内容，reset 不应把模型/凭据回退出厂。 */
export const EXTRA_EXCLUDED_KEYS = new Set([
    'prompts',
    'prompt_order',
    'extensions',
    'name',
    ...Object.keys(settingsToUpdate).filter((key) => settingsToUpdate[key]?.[3] === true),
]);

/** 采集「v1 存了但 v3 无结构对应」的附加快照：settings 中除采样键、prompts/prompt_order/extensions/name、连接键外的其余键。
 * 用于 v1→v3 迁移时保留旧版预设的附加 prompt 设置（impersonation_prompt、bias_preset_selected 等）。
 * 空结果返回 null（调用点统一「非空才写」）。 */
export function captureExtra(settings: Record<string, unknown>): Record<string, any> | null {
    const extra: Record<string, any> = {};
    for (const [key, value] of Object.entries(settings)) {
        if (SAMPLING_KEYS.some((k) => k === key)) continue;
        if (EXTRA_EXCLUDED_KEYS.has(key)) continue;
        extra[key] = value;
    }
    return Object.keys(extra).length > 0 ? extra : null;
}

/** 应用附加快照到预设：Object.assign 还原（保留 extensions）；只写 extra 中存在的键。 */
export function applyExtra(preset: Preset, extra: Record<string, any>): void {
    const ext = preset.extensions;
    Object.assign(preset, extra);
    preset.extensions = ext;
}

/** 采样 sparse 差异采集：只保留相对 baseline 值不同的键；无差异返回 null。 */
export function diffSampling(current: PromptSampling | null | undefined, baseline?: PromptSampling): PromptSampling | null {
    if (!current) return null;
    const out: PromptSampling = {};
    for (const key of SAMPLING_KEYS) {
        const value = (current as Record<string, unknown>)[key];
        if (value === undefined) continue;
        if ((baseline as Record<string, unknown> | undefined)?.[key] !== value) {
            (out as Record<string, unknown>)[key] = value;
        }
    }
    return Object.keys(out).length > 0 ? out : null;
}

/** extra sparse 差异采集：只保留相对 baseline 值不同的键；无差异返回 null。 */
export function diffExtra(current: Record<string, any> | null | undefined, baseline?: Record<string, any>): Record<string, any> | null {
    if (!current) return null;
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(current)) {
        if (baseline?.[key] !== value) out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : null;
}

/**
 * 采集单个 prompt 的值字段（仅白名单键，跳过 undefined）。
 * 纯读取，不修改 preset。
 */
export function capturePromptFields(prompt: Record<string, any> | undefined): PromptFields {
    const fields: PromptFields = {};
    if (!prompt) return fields;
    for (const key of PROMPT_FIELD_WHITELIST) {
        const value = prompt[key];
        if (value !== undefined) {
            fields[key] = value;
        }
    }
    return fields;
}

/** 只保留白名单键的值字段（R10：应用边界防御，丢弃导入/旧数据里的任意键）。 */
export function filterFields(fields: Record<string, any> | undefined): PromptFields {
    const out: PromptFields = {};
    if (!fields) return out;
    for (const key of PROMPT_FIELD_WHITELIST) {
        if (fields[key] !== undefined) out[key] = fields[key];
    }
    return out;
}

/**
 * R2 镜像 hack（必要 ST workaround，勿删）：若编辑的是当前激活预设，
 * 同步值字段到运行时的 oai_settings.prompts：生成时 promptManager 读的就是这个对象
 * （openai.js:1557），不依赖异步的 #settings_preset_openai 刷新；同时让
 * 「以当前设置覆盖」不再有旧值可回退覆盖（R2：#update_oai_preset →
 * getChatCompletionPreset(oai_settings) 会把存盘预设覆盖成 oai_settings 的旧快照，
 * 导致本编辑被抹掉）。
 */
export function mirrorFieldsToActivePreset(presetName: string, identifier: string, fields: PromptFields): void {
    if (oai_settings.preset_settings_openai !== presetName) return;
    const livePrompts = Array.isArray(oai_settings.prompts) ? oai_settings.prompts : [];
    const livePrompt = livePrompts.find((p: any) => p && p.identifier === identifier);
    if (livePrompt) {
        Object.assign(livePrompt, filterFields(fields));
    }
}

/** 在预设中按 identifier 查找 prompt（Array.isArray 守卫兼容旧对象格式）。 */
export function findPromptInPreset(preset: Preset, identifier: string): any | undefined {
    const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    return prompts.find((p: any) => p && p.identifier === identifier);
}
