import { describe, it, expect } from 'vitest';
import { parseV3Export } from '../src/core/importexport/import.js';

describe('core import/export: parseV3Export', () => {
    it('restores preset body and v4 file from a v3-compatible export', () => {
        const text = JSON.stringify({
            name: 'P',
            prompts: [{ identifier: 'a', content: 'A', enabled: true }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
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
                    ],
                },
            },
        });

        const { preset, file } = parseV3Export(text, 'key-1');

        expect(preset.name).toBe('P');
        expect(preset.prompts).toEqual([{ identifier: 'a', content: 'A', enabled: true }]);
        // preset 本体不再内嵌 v3 profiles 容器
        expect(preset.extensions.preset_cards).toBeUndefined();
        expect(file.version).toBe(4);
        expect(file.nodes.map((n) => n.id)).toEqual(['root', 'A']);
    });
});
