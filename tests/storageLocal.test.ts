import { describe, it, expect } from 'vitest';
import { createLocalStoragePort } from '../src/core/storage/local.js';
import { addProfileNode, createPresetCardsFile } from '../src/core/codec/v4.js';

function memoryStorage(): Storage {
    const store = new Map<string, string>();
    return {
        get length() { return store.size; },
        clear: () => store.clear(),
        getItem: (k) => store.get(k) ?? null,
        key: (i) => [...store.keys()][i] ?? null,
        removeItem: (k) => { store.delete(k); },
        setItem: (k, v) => { store.set(k, String(v)); },
    };
}

describe('storage local: createLocalStoragePort', () => {
    it('persists v4 file as JSON under a prefixed key', async () => {
        const backing = memoryStorage();
        const port = createLocalStoragePort(backing, 'pc:');
        let file = createPresetCardsFile({ name: 'P', prompts: [], prompt_order: [] }, 'key-1');
        file = addProfileNode(file, { id: 'A', name: 'A', presetSnapshot: { name: 'P', prompts: [], prompt_order: [] } });

        await port.saveFile(file);
        const loaded = await port.loadFile('key-1');
        expect(loaded?.nodes.map((n) => n.id)).toEqual(['root', 'A']);
        expect(backing.getItem('pc:key-1')).toContain('"version": 4');

        await port.deleteFile('key-1');
        expect(await port.loadFile('key-1')).toBeUndefined();
    });
});
