import { describe, it, expect } from 'vitest';
import { migrateV3MetaToV4 } from '../src/core/storage/migrate.js';

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
