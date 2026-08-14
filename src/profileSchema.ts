// v3 profile 数据形状校验（导入/运行时防御）——校验实现已下沉到 core/domain/schema.ts。
// 本文件保留导入语义（LegacyProfileFormatError / assertV3ImportPayload）并 re-export 形状校验。

import { isV3BaseProfileData, isV3DeltaProfileData } from './core/domain/schema.js';

export {
    isPromptFieldsData,
    isV3BaseProfileData,
    isV3DeltaProfileData,
    isV3PromptEntry,
    PROMPT_FIELD_KEYS,
} from './core/domain/schema.js';

export class LegacyProfileFormatError extends Error {
    constructor() {
        super('Only formatVersion 3 prompt profiles can be imported');
        this.name = 'LegacyProfileFormatError';
    }
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
    // 内嵌父状态（delta 导出自带）：形状为 { name, prompts }（非完整 base），仅校验 prompts 数组即可。
    if (isV3DeltaProfileData(parsed) && deltaBase !== undefined
        && (typeof deltaBase !== 'object' || deltaBase === null || Array.isArray(deltaBase) || !Array.isArray((deltaBase as Record<string, unknown>).prompts))) {
        throw new LegacyProfileFormatError();
    }
}
