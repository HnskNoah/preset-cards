import { describe, it, expect } from 'vitest';
import { applyStagedToSnapshot, createEditorStore } from '../src/core/store/EditorStore.js';
import type { PresetSnapshot } from '../src/core/domain/types.js';

const snapshot: PresetSnapshot = {
    name: 'P',
    prompts: [{ identifier: 'a', content: 'A' }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
};

describe('EditorStore', () => {
    it('stages an edit, marks dirty, and undoes it', () => {
        const store = createEditorStore({
            nodeId: 'A',
            snapshot,
            staged: { changes: [] },
            undoStack: [],
            redoStack: [],
            dirty: false,
        });

        store.dispatch({ type: 'EDIT', identifier: 'a', fields: { content: 'B' } });
        expect(store.getState().dirty).toBe(true);
        expect(store.getState().staged.changes).toEqual([
            { identifier: 'a', fields: { content: 'B' } },
        ]);

        store.dispatch({ type: 'UNDO' });
        expect(store.getState().staged.changes).toEqual([]);
        expect(store.getState().dirty).toBe(false);
    });

    it('stages an enabled toggle and removes it when toggled back to the original value', () => {
        const store = createEditorStore({
            nodeId: 'A',
            snapshot,
            staged: { changes: [] },
            undoStack: [],
            redoStack: [],
            dirty: false,
        });

        store.dispatch({ type: 'TOGGLE', identifier: 'a', enabled: false });
        expect(store.getState().staged.changes).toEqual([{ identifier: 'a', enabled: false }]);

        store.dispatch({ type: 'TOGGLE', identifier: 'a', enabled: true });
        expect(store.getState().staged.changes).toEqual([]);
        expect(store.getState().dirty).toBe(false);
    });

    it('stages a full mounted order and clears it when matching the snapshot order', () => {
        const twoPromptSnapshot: PresetSnapshot = {
            name: 'P',
            prompts: [
                { identifier: 'a', content: 'A' },
                { identifier: 'b', content: 'B' },
            ],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: true }] }],
        };
        const store = createEditorStore({
            nodeId: 'A',
            snapshot: twoPromptSnapshot,
            staged: { changes: [] },
            undoStack: [],
            redoStack: [],
            dirty: false,
        });

        store.dispatch({ type: 'REORDER', order: ['b', 'a'] });
        expect(store.getState().staged.order).toEqual(['b', 'a']);
        expect(store.getState().dirty).toBe(true);

        store.dispatch({ type: 'REORDER', order: ['a', 'b'] });
        expect(store.getState().staged.order).toBeUndefined();
        expect(store.getState().dirty).toBe(false);
    });

    it('applies staged changes into a new snapshot for commit', () => {
        const next = applyStagedToSnapshot(snapshot, {
            changes: [{ identifier: 'a', enabled: false, fields: { content: 'B' } }],
            order: ['a'],
            topLevel: { temperature: 1.2 },
        });

        expect(next.prompts).toEqual([{ identifier: 'a', content: 'B' }]);
        expect(next.prompt_order).toEqual([
            { character_id: 100001, order: [{ identifier: 'a', enabled: false }] },
        ]);
        expect(next.temperature).toBe(1.2);
    });
});
