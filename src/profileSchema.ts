/** v3 profile 数据形状校验（导入/运行时防御）。
 * 只校验 v3 结构字段，sampling/extra 等可选扩展字段（v2 子集保留）不在此白名单内——多余键不拒绝。 */

export const PROMPT_FIELD_KEYS = [
    'content',
    'name',
    'role',
    'injection_position',
    'injection_depth',
] as const;

const PROMPT_FIELD_KEY_SET = new Set<string>(PROMPT_FIELD_KEYS);

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

export class LegacyProfileFormatError extends Error {
    constructor() {
        super('Only formatVersion 3 prompt profiles can be imported');
        this.name = 'LegacyProfileFormatError';
    }
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

export function isV3BaseProfileData(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const profile = value as Record<string, unknown>;
    return profile.formatVersion === 3 && profile.kind === 'prompt_base'
        && typeof profile.id === 'string' && typeof profile.name === 'string'
        && Array.isArray(profile.prompts) && profile.prompts.every(isV3PromptEntry);
}

export function isV3DeltaProfileData(value: unknown): boolean {
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

export function assertV3ImportPayload(parsed: Record<string, unknown>): void {
    if (parsed.kind === 'prompt_tree') {
        if (parsed.formatVersion !== 3 || !Array.isArray(parsed.profiles)
            || !parsed.profiles.every((p) => isV3BaseProfileData(p) || isV3DeltaProfileData(p))) {
            throw new LegacyProfileFormatError();
        }
        return;
    }
    if (!isV3BaseProfileData(parsed) && !isV3DeltaProfileData(parsed)) throw new LegacyProfileFormatError();
    const deltaBase = parsed.base;
    if (isV3DeltaProfileData(parsed) && deltaBase !== undefined && !isV3BaseProfileData(deltaBase)) {
        throw new LegacyProfileFormatError();
    }
}
