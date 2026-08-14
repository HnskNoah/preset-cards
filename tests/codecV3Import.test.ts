import { describe, it, expect } from 'vitest';
import { fromV3BaseProfile, fromV3Profiles } from '../src/core/codec/v3.js';
import type { PromptBaseProfile, PromptDeltaProfile } from '../src/core/domain/types.js';

describe('codec v3: fromV3BaseProfile (v3 → v4)', () => {
    it('restores a v3 Base into a v4 file with a hidden root and a root-level profile node', () => {
        const v3Base: PromptBaseProfile = {
            formatVersion: 3,
            kind: 'prompt_base',
            id: 'A',
            name: 'A',
            prompts: [
                {
                    identifier: 'a',
                    mounted: true,
                    enabled: true,
                    lastActiveIndex: 0,
                    fields: { content: 'hello' },
                },
                { identifier: 'b', mounted: false, enabled: false },
            ],
        };

        const file = fromV3BaseProfile(v3Base, 'key-1');

        expect(file.version).toBe(4);
        expect(file.nodes.map((n) => n.id)).toEqual(['root', 'A']);
        const root = file.nodes.find((n) => n.id === 'root')!;
        const a = file.nodes.find((n) => n.id === 'A')!;
        expect(a.parentId).toBe('root');
        // A 的快照还原完整 prompts + prompt_order(只挂载 a)
        expect(a.presetSnapshot.prompts).toEqual([
            { identifier: 'a', content: 'hello' },
            { identifier: 'b' },
        ]);
        expect(a.presetSnapshot.prompt_order).toEqual([
            { character_id: 100001, order: [{ identifier: 'a', enabled: true }] },
        ]);
        // root 保存导入时快照,与 A 相同(导入即基线)
        expect(root.presetSnapshot).toEqual(a.presetSnapshot);
    });
});

describe('codec v3: fromV3Profiles (full file import)', () => {
    it('restores a Base + Delta tree into v4 nodes with parent links and stored diffs', () => {
        const base: PromptBaseProfile = {
            formatVersion: 3,
            kind: 'prompt_base',
            id: 'A',
            name: 'A',
            prompts: [
                { identifier: 'a', mounted: true, enabled: true, lastActiveIndex: 0, fields: { content: 'A' } },
            ],
        };
        const delta: PromptDeltaProfile = {
            formatVersion: 3,
            kind: 'prompt_delta',
            id: 'B',
            name: 'B',
            baseId: 'A',
            changes: [{ identifier: 'a', enabled: false, fields: { content: 'B' } }],
            order: ['a'],
        };

        const file = fromV3Profiles([base, delta], 'key-1');

        expect(file.nodes.map((n) => n.id)).toEqual(['root', 'A', 'B']);
        const root = file.nodes.find((n) => n.id === 'root')!;
        const a = file.nodes.find((n) => n.id === 'A')!;
        const b = file.nodes.find((n) => n.id === 'B')!;
        // root 基线 = 首个 Base 还原快照
        expect(root.presetSnapshot).toEqual(a.presetSnapshot);
        // B 挂到 A,快照 = 父快照 ⊕ delta
        expect(b.parentId).toBe('A');
        expect(b.presetSnapshot.prompts).toEqual([{ identifier: 'a', content: 'B' }]);
        expect(b.presetSnapshot.prompt_order).toEqual([
            { character_id: 100001, order: [{ identifier: 'a', enabled: false }] },
        ]);
        // B 的 diff 直接带 v3 delta(changes + order)
        expect(b.diff).toEqual({ changes: [{ identifier: 'a', enabled: false, fields: { content: 'B' } }], order: ['a'] });
        expect(file.presets[0].profileIds).toEqual(['A', 'B']);
    });
});
