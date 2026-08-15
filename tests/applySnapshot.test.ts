import { describe, it, expect } from 'vitest';
import { applySnapshotToPreset } from '../src/core/storage/apply.js';

describe('storage apply: applySnapshotToPreset', () => {
    it('overlays snapshot onto preset body/extensions while keeping the current preset_cards marker', () => {
        const preset = {
            name: 'P',
            temperature: 0.8,
            extensions: {
                preset_cards: { marker: 'preset-cards-v4', key: 'key-1' },
                other_ext: { keep: true },
            },
        };
        const snapshot = {
            name: 'P',
            prompts: [{ identifier: 'a', content: 'A' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
            temperature: 1.2,
            extensions: { other_ext: { from_snapshot: true } },
        };

        const next = applySnapshotToPreset(preset, snapshot);

        expect(next.temperature).toBe(1.2);
        expect(next.prompts).toEqual([{ identifier: 'a', content: 'A' }]);
        expect(next.extensions.other_ext).toEqual({ from_snapshot: true });
        // 当前 preset_cards 特征值保留(快照不含容器)
        expect(next.extensions.preset_cards).toEqual({ marker: 'preset-cards-v4', key: 'key-1' });
    });
});
