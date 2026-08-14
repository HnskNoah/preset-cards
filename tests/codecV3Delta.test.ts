import { describe, it, expect } from 'vitest';
import { applyV3DeltaToSnapshot } from '../src/core/codec/v3.js';
import type { PresetSnapshot, PromptDeltaProfile } from '../src/core/domain/types.js';

describe('codec v3: applyV3DeltaToSnapshot', () => {
    it('restores a delta into a full snapshot by applying changes to the parent snapshot', () => {
        const parent: PresetSnapshot = {
            name: 'P',
            prompts: [{ identifier: 'a', content: 'A', enabled: true }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
        };
        const delta: PromptDeltaProfile = {
            formatVersion: 3,
            kind: 'prompt_delta',
            id: 'B',
            name: 'B',
            baseId: 'A',
            changes: [{ identifier: 'a', enabled: false, fields: { content: 'B' } }],
            order: ['a'],
        };

        const child = applyV3DeltaToSnapshot(parent, delta);

        expect(child.prompts).toEqual([{ identifier: 'a', content: 'B' }]);
        expect(child.prompt_order).toEqual([
            { character_id: 100001, order: [{ identifier: 'a', enabled: false }] },
        ]);
    });
});
