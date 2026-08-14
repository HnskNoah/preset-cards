import { describe, it, expect } from 'vitest';
import { buildPresetEntries, createPresetStore, filterPresets } from '../src/core/store/PresetStore.js';
import type { PresetEntry } from '../src/core/store/PresetStore.js';
import { addProfileNode, createPresetCardsFile } from '../src/core/codec/v4.js';

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

    it('toggles batch selection and clears it with notifications', () => {
        const store = createPresetStore({ presets, search: '', selectedIds: new Set(), activeName: null });
        const seen: string[] = [];
        store.subscribe(() => seen.push('change'));

        store.dispatch({ type: 'TOGGLE_SELECT', name: 'Alpha' });
        store.dispatch({ type: 'TOGGLE_SELECT', name: 'Beta' });
        expect([...store.getState().selectedIds].sort()).toEqual(['Alpha', 'Beta']);

        store.dispatch({ type: 'TOGGLE_SELECT', name: 'Alpha' });
        expect([...store.getState().selectedIds]).toEqual(['Beta']);

        store.dispatch({ type: 'CLEAR_SELECT' });
        expect(store.getState().selectedIds.size).toBe(0);
        expect(seen).toEqual(['change', 'change', 'change', 'change']);
    });

    it('builds preset entries from a v4 file with profile counts and active marker', () => {
        const preset = { name: 'P', prompts: [], prompt_order: [] };
        let file = createPresetCardsFile(preset, 'key-1');
        file = addProfileNode(file, { id: 'A', name: 'A', presetSnapshot: preset });
        file = addProfileNode(file, { id: 'B', name: 'B', parentId: 'A', presetSnapshot: preset });

        const entries = buildPresetEntries(file, 'key-1');

        expect(entries).toEqual([{ name: 'P', profileCount: 2, isActive: true }]);
    });
});
