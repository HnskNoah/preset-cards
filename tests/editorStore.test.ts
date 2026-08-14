import { describe, it, expect } from 'vitest';
import { createEditorStore } from '../src/core/store/EditorStore.js';
import type { PresetSnapshot } from '../src/core/domain/types.js';

const snapshot: PresetSnapshot = {
    name: 'P',
    prompts: [{ identifier: 'a', content: 'A', enabled: true }],
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
});
