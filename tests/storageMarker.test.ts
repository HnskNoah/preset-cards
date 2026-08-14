import { describe, it, expect } from 'vitest';
import { readPresetKey, stampPresetKey } from '../src/core/storage/marker.js';

describe('storage marker: preset key feature value', () => {
    it('writes and reads the preset_cards marker with the given key', () => {
        const preset: Record<string, any> = { name: 'P', extensions: { other: 1 } };

        const stamped = stampPresetKey(preset, 'key-1');
        expect(stamped.extensions.preset_cards).toEqual({ marker: 'preset-cards-v4', key: 'key-1' });
        expect(stamped.extensions.other).toBe(1);

        expect(readPresetKey(stamped)).toBe('key-1');
    });

    it('returns undefined when no preset_cards marker exists', () => {
        expect(readPresetKey({ name: 'P', extensions: {} })).toBeUndefined();
    });
});
