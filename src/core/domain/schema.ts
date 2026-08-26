// core/domain schema：v3 数据形状校验与类型判别，与领域类型同源。
// 零 ST 依赖；profileSchema / meta 从上层 re-export 保持既有 API。
import type { PresetProfile, PromptBaseProfile, PromptDeltaProfile, PromptFields } from './types.js';

export const PROMPT_FIELD_KEYS = [
    'content',
    'name',
    'role',
    'injection_position',
    'injection_depth',
] as const;

const PROMPT_FIELD_KEY_SET = new Set<string>(PROMPT_FIELD_KEYS);

/**
 * 明确定义「不随 profile 快照复制」的 prompt identifier：
 * 这些是第三方扩展自管理的固定名 prompt（content 可能是巨大的设置对象），
 * 采集/挂载还原时一律跳过——不进入 profile 的 prompts/unusedIds/order 与 defaultSnapshot。
 * 应用时保持 preset 现状（由扩展自己管理），避免复制巨大内容或干扰其内部状态。
 */
export const PROMPT_NEVER_CAPTURE = new Set<string>(['SPresetSettings']);

export function isNeverCaptureIdentifier(identifier: string): boolean {
    return PROMPT_NEVER_CAPTURE.has(identifier);
}

export function isPromptFieldsData(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const fields = value as Record<string, unknown>;
    return Object.keys(fields).every((key) => {
        if (!PROMPT_FIELD_KEY_SET.has(key)) return false;
        const fieldValue = fields[key];
        return key === 'injection_position' || key === 'injection_depth'
            ? typeof fieldValue === 'number'
            : typeof fieldValue === 'string';
    });
}

export function isV3PromptEntry(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const entry = value as Record<string, unknown>;
    return typeof entry.identifier === 'string'
        && typeof entry.mounted === 'boolean'
        && typeof entry.enabled === 'boolean'
        && (entry.lastActiveIndex === undefined || typeof entry.lastActiveIndex === 'number')
        && (entry.fields === undefined || isPromptFieldsData(entry.fields));
}

export function isV3BaseProfileData(value: unknown): value is PromptBaseProfile {
    if (!value || typeof value !== 'object') return false;
    const profile = value as Record<string, unknown>;
    return profile.formatVersion === 3 && profile.kind === 'prompt_base'
        && typeof profile.id === 'string' && typeof profile.name === 'string'
        && Array.isArray(profile.prompts) && profile.prompts.every(isV3PromptEntry)
        && (profile.unusedIds === undefined
            ? true
            : Array.isArray(profile.unusedIds) && profile.unusedIds.every((id) => typeof id === 'string'));
}

export function isV3DeltaProfileData(value: unknown): value is PromptDeltaProfile {
    if (!value || typeof value !== 'object') return false;
    const profile = value as Record<string, unknown>;
    return profile.formatVersion === 3 && profile.kind === 'prompt_delta'
        && typeof profile.id === 'string' && typeof profile.name === 'string' && typeof profile.baseId === 'string'
        && Array.isArray(profile.changes)
        && profile.changes.every((raw) => {
            if (!raw || typeof raw !== 'object') return false;
            const change = raw as Record<string, unknown>;
            return typeof change.identifier === 'string'
                && (change.mounted === undefined || typeof change.mounted === 'boolean')
                && (change.enabled === undefined || typeof change.enabled === 'boolean')
                && (change.lastActiveIndex === undefined || typeof change.lastActiveIndex === 'number')
                && (change.fields === undefined || isPromptFieldsData(change.fields));
        })
        && (profile.order === undefined || (Array.isArray(profile.order) && profile.order.every((id) => typeof id === 'string')));
}

export function isPromptBaseProfile(profile: PresetProfile): profile is PromptBaseProfile {
    return isV3BaseProfileData(profile);
}

export function isPromptDeltaProfile(profile: PresetProfile): profile is PromptDeltaProfile {
    return isV3DeltaProfileData(profile);
}

export type { PromptFields };
