// core/storage local：localStorage/IndexedDB 载体 StoragePort（浏览器可用，纯异步封装）。
import { parseV4File, serializeV4File } from './file.js';
import type { StoragePort } from './port.js';

/** 用 Storage 接口(localStorage)做载体；key 加前缀避免冲突。 */
export function createLocalStoragePort(storage: Storage, prefix = 'preset-cards:'): StoragePort {
    const keyFor = (key: string) => `${prefix}${key}`;
    return {
        async loadFile(key) {
            const raw = storage.getItem(keyFor(key));
            if (raw === null) return undefined;
            try {
                return parseV4File(raw);
            } catch {
                return undefined;
            }
        },
        async saveFile(file) {
            storage.setItem(keyFor(file.presets[0]?.key ?? ''), serializeV4File(file));
        },
        async deleteFile(key) {
            storage.removeItem(keyFor(key));
        },
    };
}
