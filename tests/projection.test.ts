import { describe, it, expect } from 'vitest';
import { buildPresetMarker, buildProfileMarker } from '../src/core/storage/marker.js';
import { buildProjectedPreset } from '../src/core/storage/project.js';

describe('storage marker: preset vs profile identity', () => {
    it('builds preset and profile markers with identity fields', () => {
        expect(buildPresetMarker('k1')).toEqual({ marker: 'preset-cards-v4', key: 'k1', kind: 'preset' });
        expect(buildProfileMarker('k2', 'A', 'Combat', 'root')).toEqual({
            marker: 'preset-cards-v4',
            key: 'k2',
            kind: 'profile',
            profileId: 'A',
            profileName: 'Combat',
            parentKey: 'root',
        });
    });
});

describe('storage projection: buildProjectedPreset', () => {
    it('builds an ST preset body from a node snapshot with identity marker', () => {
        const snapshot = {
            name: 'P',
            prompts: [{ identifier: 'a', content: 'A' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
            extensions: { other_ext: { foo: 1 } },
        };

        const marker = buildProfileMarker('k2', 'A', 'Combat', 'root');
        const projected = buildProjectedPreset(snapshot, marker);

        expect(projected.prompts).toEqual(snapshot.prompts);
        expect(projected.extensions.other_ext).toEqual({ foo: 1 });
        expect(projected.extensions.preset_cards).toEqual(marker);
    });
});
