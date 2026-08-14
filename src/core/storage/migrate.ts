// core/storage migrate：v3 内嵌容器 → v4 独立文件迁移（零 ST 依赖，纯函数）。
import { fromV3Profiles } from '../codec/v3.js';
import type { PresetCardsFile } from '../domain/types.js';

export interface MigrationResult {
    file: PresetCardsFile;
    key: string;
}

/** 从 v3 preset.extensions['preset_cards'].profiles 迁移出 v4 文件；无 profiles 时返回空文件。 */
export function migrateV3MetaToV4(preset: Record<string, any>, key: string): MigrationResult {
    const profiles = preset?.extensions?.preset_cards?.profiles;
    const file: PresetCardsFile = Array.isArray(profiles) && profiles.length > 0
        ? fromV3Profiles(profiles, key)
        : { version: 4 as const, presets: [{ key, profileIds: [] }], nodes: [] };
    return { file, key };
}
