// core/storage port：v4 文件存取契约（零 ST 依赖；adapter 提供 ST 实现，测试用内存实现）。
import type { PresetCardsFile } from '../domain/types.js';

export interface StoragePort {
    loadFile(key: string): Promise<PresetCardsFile | undefined>;
    saveFile(file: PresetCardsFile): Promise<void>;
    deleteFile(key: string): Promise<void>;
}

/** 内存实现：纯异步、可测，adapter 可替换为 ST/IndexedDB/文件系统。 */
export function createMemoryStoragePort(): StoragePort {
    const files = new Map<string, PresetCardsFile>();
    return {
        async loadFile(key) {
            return files.get(key);
        },
        async saveFile(file) {
            files.set(file.presets[0]?.key ?? keyOf(file), structuredClone(file));
        },
        async deleteFile(key) {
            files.delete(key);
        },
    };
}

function keyOf(file: PresetCardsFile): string {
    return file.presets[0]?.key ?? '';
}
