import { describe, it, expect } from 'vitest';
import { ensureV4File, migrateV3MetaToV4 } from '../src/core/storage/migrate.js';
import { createMemoryStoragePort } from '../src/core/storage/port.js';
import { readPresetKey } from '../src/core/storage/marker.js';

describe('storage migrate: migrateV3MetaToV4', () => {
    it('converts v3 Base/Delta profiles in preset.extensions into a v4 file', () => {
        const preset: Record<string, any> = {
            name: 'P',
            extensions: {
                preset_cards: {
                    profiles: [
                        {
                            formatVersion: 3,
                            kind: 'prompt_base',
                            id: 'A',
                            name: 'A',
                            prompts: [
                                { identifier: 'a', mounted: true, enabled: true, lastActiveIndex: 0, fields: { content: 'A' } },
                            ],
                        },
                        {
                            formatVersion: 3,
                            kind: 'prompt_delta',
                            id: 'B',
                            name: 'B',
                            baseId: 'A',
                            changes: [{ identifier: 'a', enabled: false, fields: { content: 'B' } }],
                            order: ['a'],
                        },
                    ],
                },
            },
        };

        const { file } = migrateV3MetaToV4(preset, 'key-1');

        expect(file.version).toBe(4);
        expect(file.nodes.map((n) => n.id)).toEqual(['root', 'A', 'B']);
        const a = file.nodes.find((n) => n.id === 'A')!;
        const b = file.nodes.find((n) => n.id === 'B')!;
        expect(a.presetSnapshot.prompts).toEqual([{ identifier: 'a', content: 'A' }]);
        expect(b.parentId).toBe('A');
        expect(b.diff).toEqual({ changes: [{ identifier: 'a', enabled: false, fields: { content: 'B' } }], order: ['a'] });
    });
});

describe('storage migrate: ensureV4File', () => {
    it('migrates v3 container, saves v4 file, and stamps the preset key on first run', async () => {
        const preset: Record<string, any> = {
            name: 'P',
            extensions: {
                preset_cards: {
                    profiles: [{
                        formatVersion: 3,
                        kind: 'prompt_base',
                        id: 'A',
                        name: 'A',
                        prompts: [{ identifier: 'a', mounted: true, enabled: true, fields: { content: 'A' } }],
                    }],
                },
            },
        };
        const storage = createMemoryStoragePort();

        const result = await ensureV4File(preset, 'key-1', storage);

        expect(readPresetKey(result.preset)).toBe('key-1');
        const loaded = await storage.loadFile('key-1');
        expect(loaded?.nodes.map((n) => n.id)).toEqual(['root', 'A']);
        expect(result.file.nodes.map((n) => n.id)).toEqual(['root', 'A']);
    });
});
