import { describe, it, expect } from 'vitest';
import { buildV3Export } from '../src/core/importexport/export.js';
import { addProfileNode, createPresetCardsFile } from '../src/core/codec/v4.js';

describe('core import/export: buildV3Export', () => {
    it('assembles a v3-compatible preset export from a v4 file', () => {
        let file = createPresetCardsFile({ name: 'P', prompts: [], prompt_order: [] }, 'key-1');
        file = addProfileNode(file, {
            id: 'A',
            name: 'A',
            presetSnapshot: {
                name: 'P',
                prompts: [{ identifier: 'a', content: 'A' }],
                prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
            },
        });

        const exportObj = buildV3Export(file);

        expect(exportObj.name).toBe('P');
        expect(exportObj.extensions.preset_cards.profiles).toHaveLength(1);
        const base = exportObj.extensions.preset_cards.profiles[0];
        expect(base.kind).toBe('prompt_base');
        expect(base.id).toBe('A');
        expect(base.prompts[0]).toMatchObject({
            identifier: 'a',
            mounted: true,
            enabled: true,
            fields: { content: 'A' },
        });
    });
});
