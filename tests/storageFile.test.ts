import { describe, it, expect } from 'vitest';
import { parseV4File, serializeV4File } from '../src/core/storage/file.js';
import { addProfileNode, createPresetCardsFile } from '../src/core/codec/v4.js';

describe('storage file: v4 serialize/parse', () => {
    it('round-trips a v4 file through JSON', () => {
        let file = createPresetCardsFile({ name: 'P', prompts: [], prompt_order: [] }, 'key-1');
        file = addProfileNode(file, { id: 'A', name: 'A', presetSnapshot: { name: 'P', prompts: [], prompt_order: [] } });

        const parsed = parseV4File(serializeV4File(file));

        expect(parsed.version).toBe(4);
        expect(parsed.nodes.map((n) => n.id)).toEqual(['root', 'A']);
    });

    it('rejects non-v4 or malformed files', () => {
        expect(() => parseV4File(JSON.stringify({ version: 3 }))).toThrow();
        expect(() => parseV4File('not json')).toThrow();
    });
});
