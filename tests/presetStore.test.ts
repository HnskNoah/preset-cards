import { describe, it, expect } from 'vitest';
import { buildPresetEntries, createPresetStore, deriveCardView, filterPresets } from '../src/core/store/PresetStore.js';
import type { PresetEntry } from '../src/core/store/PresetStore.js';
import type { PresetCardsFile } from '../src/core/domain/types.js';

const presets: PresetEntry[] = [
    { name: 'Alpha', profileCount: 2, isActive: true },
    { name: 'Beta', profileCount: 0, isActive: false },
];

describe('PresetStore', () => {
    it('initializes with preset list and notifies subscribers on state change', () => {
        const store = createPresetStore({ presets, search: '', selectedIds: new Set(), activeName: 'Alpha', isBatchMode: false });
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
        const store = createPresetStore({ presets, search: '', selectedIds: new Set(), activeName: null, isBatchMode: false });
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
        const file: PresetCardsFile = {
            version: 4,
            presets: [{ key: 'key-1', profileIds: ['A', 'B'] }],
            nodes: [
                { id: 'root', name: 'root', presetSnapshot: preset },
                { id: 'A', name: 'A', parentId: 'root', presetSnapshot: preset },
                { id: 'B', name: 'B', parentId: 'A', presetSnapshot: preset },
            ],
        };

        const entries = buildPresetEntries(file, 'key-1');

        expect(entries).toEqual([{ name: 'P', profileCount: 2, isActive: true }]);
    });
});

describe('PresetStore batch mode + derived view', () => {
    const baseState = { presets, search: '', selectedIds: new Set<string>(), activeName: null, isBatchMode: false };

    it('toggles batch mode with notifications', () => {
        const store = createPresetStore(baseState);
        const seen: string[] = [];
        store.subscribe(() => seen.push('change'));

        store.dispatch({ type: 'TOGGLE_BATCH_MODE' });
        expect(store.getState().isBatchMode).toBe(true);
        store.dispatch({ type: 'TOGGLE_BATCH_MODE' });
        expect(store.getState().isBatchMode).toBe(false);
        expect(seen).toEqual(['change', 'change']);
    });

    it('derives visible/selected names for the card UI from store state', () => {
        const store = createPresetStore(baseState);
        store.dispatch({ type: 'SET_SEARCH', query: 'al' });
        store.dispatch({ type: 'TOGGLE_SELECT', name: 'Alpha' });
        store.dispatch({ type: 'TOGGLE_BATCH_MODE' });

        const view = deriveCardView(store.getState());

        expect(view.isBatchMode).toBe(true);
        expect(view.visibleNames).toEqual(['Alpha']);
        expect(view.selectedNames).toEqual(['Alpha']);
    });
});
