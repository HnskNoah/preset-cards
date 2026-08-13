import { describe, it, expect } from 'vitest';
import { buildProfileForest, buildProfileNested } from '../src/profileTree.js';

describe('profileTree', () => {
    const base = (id: string, name: string) => ({ formatVersion: 3, kind: 'prompt_base', id, name, prompts: [] });
    const delta = (id: string, name: string, baseId: string) => ({ formatVersion: 3, kind: 'prompt_delta', id, name, baseId, changes: [] });

    it('builds forest from flat profiles', () => {
        const forest = buildProfileForest([
            base('a', 'A'),
            delta('b', 'B', 'a'),
            delta('c', 'C', 'b'),
            delta('d', 'D', 'a'),
        ]);
        expect(forest).toHaveLength(1);
        expect(forest[0].profile.id).toBe('a');
        expect(forest[0].children).toHaveLength(2);
        expect(forest[0].children.map((c) => c.profile.id)).toEqual(['b', 'd']);
        expect(forest[0].children[0].children[0].profile.id).toBe('c');
    });

    it('handles orphan deltas (parent missing)', () => {
        const forest = buildProfileForest([
            base('a', 'A'),
            delta('b', 'B', 'missing'),
        ]);
        expect(forest).toHaveLength(2);
        expect(forest.map((r) => r.profile.id)).toEqual(['a', 'b']);
    });

    it('builds nested trees with depth', () => {
        const forest = buildProfileForest([
            base('a', 'A'),
            delta('b', 'B', 'a'),
        ]);
        const nested = buildProfileNested(forest);
        expect(nested).toHaveLength(1);
        expect(nested[0].depth).toBe(0);
        expect(nested[0].children[0].depth).toBe(1);
    });
});