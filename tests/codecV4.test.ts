import { describe, it, expect } from 'vitest';
import { addProfileNode, createPresetCardsFile, deleteNode, updateProfileNode } from '../src/core/codec/v4.js';
import type { PresetSnapshot } from '../src/core/domain/types.js';

/**
 * Phase 1 codec v4 行为：
 * 导入一个 preset 时生成 preset-cards.json 文件对象——root node 保存导入时完整快照，
 * presets[] 记录该 preset 的特征值关联，root 是隐藏基线（不显示）。
 */
describe('codec v4: createPresetCardsFile', () => {
    it('creates a v4 file with a hidden root node holding the full imported snapshot', () => {
        const preset: PresetSnapshot = {
            name: 'P',
            prompts: [{ identifier: 'a', content: 'hello', enabled: true }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
            extensions: { other_ext: { foo: 1 } },
        };
        const file = createPresetCardsFile(preset, 'key-1');

        expect(file.version).toBe(4);
        expect(file.presets).toEqual([{ key: 'key-1', profileIds: [] }]);
        expect(file.nodes).toHaveLength(1);
        const root = file.nodes[0];
        expect(root.id).toBe('root');
        expect(root.parentId).toBeUndefined();
        expect(root.presetSnapshot).toEqual(preset);
    });

    it('root snapshot does not contain the preset_cards container itself', () => {
        const preset: PresetSnapshot = {
            name: 'P',
            prompts: [],
            prompt_order: [],
            extensions: {
                preset_cards: { marker: 'preset-cards-v4', key: 'key-1', profiles: [{ id: 'x' }] },
                other_ext: { foo: 1 },
            },
        };
        const file = createPresetCardsFile(preset, 'key-1');
        const rootSnapshot = file.nodes[0].presetSnapshot as PresetSnapshot;
        expect(rootSnapshot.extensions).not.toHaveProperty('preset_cards');
        expect(rootSnapshot.extensions).toHaveProperty('other_ext');
    });
});

describe('codec v4: addProfileNode', () => {
    it('adds a root-level profile node with full snapshot and records it in preset ownership', () => {
        const preset: PresetSnapshot = {
            name: 'P',
            prompts: [{ identifier: 'a', content: 'hello', enabled: true }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
        };
        const file = createPresetCardsFile(preset, 'key-1');
        const aSnapshot: PresetSnapshot = {
            name: 'P',
            prompts: [{ identifier: 'a', content: 'hello v2', enabled: true }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
        };

        const next = addProfileNode(file, { id: 'A', name: 'A', presetSnapshot: aSnapshot });

        expect(next.nodes).toHaveLength(2);
        const a = next.nodes.find((n) => n.id === 'A')!;
        expect(a.parentId).toBe('root');
        expect(a.presetSnapshot).toEqual(aSnapshot);
        expect(next.presets[0].profileIds).toEqual(['A']);
    });

    it('derives a child node from a non-root parent', () => {
        const preset: PresetSnapshot = { name: 'P', prompts: [], prompt_order: [] };
        const file = createPresetCardsFile(preset, 'key-1');
        const withA = addProfileNode(file, {
            id: 'A',
            name: 'A',
            presetSnapshot: { name: 'P', prompts: [], prompt_order: [] },
        });
        const bSnapshot: PresetSnapshot = {
            name: 'P',
            prompts: [{ identifier: 'a', content: 'B', enabled: false }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: false }] }],
        };

        const withB = addProfileNode(withA, { id: 'B', name: 'B', presetSnapshot: bSnapshot, parentId: 'A' });

        const b = withB.nodes.find((n) => n.id === 'B')!;
        expect(b.parentId).toBe('A');
        expect(b.presetSnapshot).toEqual(bSnapshot);
        expect(withB.presets[0].profileIds).toEqual(['A', 'B']);
    });
});

describe('codec v4: deleteNode (cascade)', () => {
    it('deletes a node and all its descendants, and removes them from ownership', () => {
        const preset: PresetSnapshot = { name: 'P', prompts: [], prompt_order: [] };
        const file = createPresetCardsFile(preset, 'key-1');
        const withA = addProfileNode(file, {
            id: 'A',
            name: 'A',
            presetSnapshot: { name: 'P', prompts: [], prompt_order: [] },
        });
        const withB = addProfileNode(withA, {
            id: 'B',
            name: 'B',
            presetSnapshot: { name: 'P', prompts: [], prompt_order: [] },
            parentId: 'A',
        });
        const withC = addProfileNode(withB, {
            id: 'C',
            name: 'C',
            presetSnapshot: { name: 'P', prompts: [], prompt_order: [] },
            parentId: 'B',
        });

        const next = deleteNode(withC, 'A');

        expect(next.nodes.map((n) => n.id)).toEqual(['root']);
        expect(next.presets[0].profileIds).toEqual([]);
    });
});

describe('codec v4: updateProfileNode', () => {
    it('replaces the snapshot and recomputes diff against the parent snapshot', () => {
        const preset: PresetSnapshot = {
            name: 'P',
            prompts: [{ identifier: 'a', content: 'A', enabled: true }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
        };
        const file = createPresetCardsFile(preset, 'key-1');
        const withA = addProfileNode(file, { id: 'A', name: 'A', presetSnapshot: preset });
        const updated: PresetSnapshot = {
            name: 'P',
            prompts: [{ identifier: 'a', content: 'B', enabled: true }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
        };

        const next = updateProfileNode(withA, 'A', updated);
        const a = next.nodes.find((n) => n.id === 'A')!;
        expect(a.presetSnapshot.prompts).toEqual([{ identifier: 'a', content: 'B', enabled: true }]);
        // A 相对 root 的 diff 重算:content A → B
        expect(a.diff).toEqual({ changes: [{ identifier: 'a', fields: { content: 'B' } }] });
    });
});
