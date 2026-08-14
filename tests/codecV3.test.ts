import { describe, it, expect } from 'vitest';
import { toV3Profiles } from '../src/core/codec/v3.js';
import { addProfileNode, createPresetCardsFile } from '../src/core/codec/v4.js';
import type { PresetSnapshot } from '../src/core/domain/types.js';

function snapshot(content: string, enabled = true): PresetSnapshot {
    return {
        name: 'P',
        prompts: [{ identifier: 'a', content, enabled }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled }] }],
    };
}

describe('codec v3: toV3Profiles', () => {
    it('exports a root-level profile as a v3 Base with full snapshot entries', () => {
        const file = createPresetCardsFile(snapshot('root'), 'key-1');
        const withA = addProfileNode(file, { id: 'A', name: 'A', presetSnapshot: snapshot('A') });

        const profiles = toV3Profiles(withA);

        expect(profiles).toHaveLength(1);
        const base = profiles[0] as any;
        expect(base.formatVersion).toBe(3);
        expect(base.kind).toBe('prompt_base');
        expect(base.id).toBe('A');
        expect(base.name).toBe('A');
        expect(base.prompts).toEqual([
            { identifier: 'a', mounted: true, enabled: true, lastActiveIndex: 0, fields: { content: 'A' } },
        ]);
    });

    it('exports a derived profile as a v3 Delta using its stored diff', () => {
        const file = createPresetCardsFile(snapshot('root'), 'key-1');
        const withA = addProfileNode(file, { id: 'A', name: 'A', presetSnapshot: snapshot('A') });
        const withB = addProfileNode(withA, {
            id: 'B',
            name: 'B',
            parentId: 'A',
            presetSnapshot: snapshot('B', false),
            diff: {
                changes: [{ identifier: 'a', enabled: false, fields: { content: 'B' } }],
                order: ['a'],
            },
        });

        const profiles = toV3Profiles(withB);

        expect(profiles).toHaveLength(2);
        const delta = profiles.find((p) => p.kind === 'prompt_delta') as any;
        expect(delta.baseId).toBe('A');
        expect(delta.changes).toEqual([{ identifier: 'a', enabled: false, fields: { content: 'B' } }]);
        expect(delta.order).toEqual(['a']);
    });
});
