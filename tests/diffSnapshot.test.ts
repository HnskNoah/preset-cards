import { describe, it, expect } from 'vitest';
import { diffSnapshot } from '../src/core/diff/snapshot.js';
import type { PresetSnapshot } from '../src/core/domain/types.js';

function preset(overrides: Partial<PresetSnapshot> = {}): PresetSnapshot {
    return {
        name: 'P',
        prompts: [{ identifier: 'a', content: 'A', enabled: true }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
        temperature: 0.8,
        ...overrides,
    };
}

describe('core diff: diffSnapshot', () => {
    it('captures a prompt field change between parent and child snapshots', () => {
        const parent = preset();
        const child = preset({
            prompts: [{ identifier: 'a', content: 'B', enabled: true }],
        });

        const diff = diffSnapshot(parent, child);

        expect(diff.prompts).toEqual([
            { identifier: 'a', fields: { content: 'B' } },
        ]);
    });

    it('captures an enabled toggle change between parent and child snapshots', () => {
        const parent = preset();
        const child = preset({
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: false }] }],
        });

        const diff = diffSnapshot(parent, child);

        expect(diff.prompts).toEqual([
            { identifier: 'a', enabled: false },
        ]);
    });
});
