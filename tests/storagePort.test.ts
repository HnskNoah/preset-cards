import { describe, it, expect } from 'vitest';
import { createMemoryStoragePort } from '../src/core/storage/port.js';
import { addProfileNode, createPresetCardsFile } from '../src/core/codec/v4.js';

describe('storage port: memory implementation', () => {
    it('saves, loads, and deletes a v4 file by key', async () => {
        const port = createMemoryStoragePort();
        let file = createPresetCardsFile({ name: 'P', prompts: [], prompt_order: [] }, 'key-1');
        file = addProfileNode(file, { id: 'A', name: 'A', presetSnapshot: { name: 'P', prompts: [], prompt_order: [] } });

        await port.saveFile(file);
        const loaded = await port.loadFile('key-1');
        expect(loaded?.nodes.map((n) => n.id)).toEqual(['root', 'A']);

        await port.deleteFile('key-1');
        expect(await port.loadFile('key-1')).toBeUndefined();
    });
});
