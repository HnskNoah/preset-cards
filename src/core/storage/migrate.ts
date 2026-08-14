// core/storage migrate：v3 内嵌容器 → v4 独立文件迁移（零 ST 依赖，纯函数）。
import { fromV3Profiles } from '../codec/v3.js';
import type { PresetCardsFile } from '../domain/types.js';
import { readPresetKey, stampPresetKey } from './marker.js';
import type { StoragePort } from './port.js';

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

export interface EnsureResult {
    file: PresetCardsFile;
    preset: Record<string, any>;
    key: string;
    migrated: boolean;
}

/** 启动入口：已有特征值 → 从存储加载 v4 文件（缺文件给空 v4）；否则 v3 迁移 + 落盘 + 打特征值。 */
export async function ensureV4File(
    preset: Record<string, any>,
    key: string,
    storage: StoragePort,
): Promise<EnsureResult> {
    const existingKey = readPresetKey(preset);
    if (existingKey !== undefined) {
        const loaded = await storage.loadFile(existingKey);
        return {
            file: loaded ?? { version: 4 as const, presets: [{ key: existingKey, profileIds: [] }], nodes: [] },
            preset,
            key: existingKey,
            migrated: false,
        };
    }
    const { file } = migrateV3MetaToV4(preset, key);
    await storage.saveFile(file);
    return { file, preset: stampPresetKey(preset, key), key, migrated: true };
}
