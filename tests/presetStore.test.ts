import { describe, it, expect } from 'vitest';
import { createPresetStore, filterPresets } from '../src/core/store/PresetStore.js';
import type { PresetEntry } from '../src/core/store/PresetStore.js';

const presets: PresetEntry[] = [
    { name: 'Alpha', profileCount: 2, isActive: true },
    { name: 'Beta', profileCount: 0, isActive: false },
];

describe('PresetStore', () => {
    it('initializes with preset list and notifies subscribers on state change', () => {
        const store = createPresetStore({ presets, search: '', selectedIds: new Set(), activeName: 'Alpha' });
        const seen: string[] = [];
        store.subscribe(() => seen.push('change'));

        store.dispatch({ type: 'SET_SEARCH', query: 'be' });

        expect(store.getState().search).toBe('be');
        expect(seen).toEqual(['change']);
        expect(store.getState().presets).toEqual(presets);
    });

    it('filters presets by name case-insensitively and returns all for empty query', () => {
        expect(filterPresets(presets, 'ALPHA').map((p) => p.name)).toEqual(['Alpha']);
        expect(filterPresets(presets, 'be').map((p) => p.name)).toEqual(['Beta']);
        expect(filterPresets(presets, '').map((p) => p.name)).toEqual(['Alpha', 'Beta']);
    });
});
