// core/storage file：preset-cards.json 文件序列化/解析（零 ST 依赖，纯函数）。
import type { PresetCardsFile } from '../domain/types.js';

export function serializeV4File(file: PresetCardsFile): string {
    return JSON.stringify(file, null, 4);
}

/** 解析并校验 v4 文件；非 JSON/非 v4/结构缺失抛错。 */
export function parseV4File(text: string): PresetCardsFile {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('Invalid preset-cards file: not JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid preset-cards file: not an object');
    }
    const file = parsed as Partial<PresetCardsFile>;
    if (file.version !== 4 || !Array.isArray(file.presets) || !Array.isArray(file.nodes)) {
        throw new Error('Invalid preset-cards file: expected version 4 with presets and nodes');
    }
    return file as PresetCardsFile;
}
