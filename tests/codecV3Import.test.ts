import { describe, it, expect } from 'vitest';
import { fromV3BaseProfile } from '../src/core/codec/v3.js';
import type { PromptBaseProfile } from '../src/core/domain/types.js';

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
