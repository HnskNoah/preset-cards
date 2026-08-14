// core/importexport import：v3 兼容完整 preset 导出 → 预设本体 + v4 文件（零 ST 依赖，纯函数）。
import { fromV3Profiles } from '../codec/v3.js';
import type { PresetCardsFile, PresetSnapshot } from '../domain/types.js';

export interface ImportedV3 {
    preset: PresetSnapshot;
    file: PresetCardsFile;
}

/** 解析 v3 完整 preset 导出：preset 本体保留（剔除 preset_cards 容器），profiles 还原为 v4 文件。 */
export function parseV3Export(text: string, key: string): ImportedV3 {
    let parsed: Record<string, any>;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('Invalid preset export: not JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid preset export: not an object');
    }

    const profiles = parsed?.extensions?.preset_cards?.profiles;
    const file = Array.isArray(profiles) && profiles.length > 0
        ? fromV3Profiles(profiles, key)
        : { version: 4 as const, presets: [{ key, profileIds: [] }], nodes: [] };

    const preset = structuredClone(parsed);
    delete preset.extensions?.preset_cards;
    return { preset: preset as PresetSnapshot, file };
}
