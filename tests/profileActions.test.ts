import { describe, it, expect } from 'vitest';
import {
    makeBaseProfile,
    makeDeltaProfile,
    buildDerivedProfile,
    collectDescendantProfileIds,
    isArchiveProfile,
} from '../src/profileActions.js';
import { newProfileId } from '../src/meta.js';

describe('profileActions', () => {
    it('builds a v3 base profile with optional fields', () => {
        const p = makeBaseProfile({
            id: 'b1',
            name: 'Base',
            prompts: [{ identifier: 'a', mounted: true, enabled: true }],
            unusedIds: ['u'],
            sampling: { temperature: 0.8 },
            extra: { bias: 'x' },
            model: { source: 'openai', name: 'gpt-4o' },
        });
        expect(p.formatVersion).toBe(3);
        expect(p.kind).toBe('prompt_base');
        expect(p.unusedIds).toEqual(['u']);
        expect(p.sampling?.temperature).toBe(0.8);
        expect(p.extra?.bias).toBe('x');
        expect(p.model?.source).toBe('openai');
        expect(p.model?.name).toBe('gpt-4o');
    });

    it('builds a v3 delta profile with order and model', () => {
        const p = makeDeltaProfile({
            id: 'd1',
            name: 'Delta',
            baseId: 'b1',
            changes: [{ identifier: 'a', enabled: false }],
            order: ['a', 'b'],
            model: { source: 'claude', name: 'claude-3' },
        });
        expect(p.formatVersion).toBe(3);
        expect(p.kind).toBe('prompt_delta');
        expect(p.order).toEqual(['a', 'b']);
        expect(p.model?.name).toBe('claude-3');
    });

    it('derives delta from parent with optional model', () => {
        const parent = makeBaseProfile({ id: 'p1', name: 'Parent', prompts: [] });
        const delta = buildDerivedProfile(parent, 'Child', [], undefined, undefined, { source: 'deepseek', name: 'deepseek-v4' });
        expect(delta.baseId).toBe('p1');
        expect(delta.model?.name).toBe('deepseek-v4');
    });

    it('collects descendant profile ids with cycle protection', () => {
        const meta = {
            profiles: [
                { id: 'a', kind: 'prompt_base', formatVersion: 3, name: 'A', prompts: [] },
                { id: 'b', kind: 'prompt_delta', formatVersion: 3, name: 'B', baseId: 'a', changes: [] },
                { id: 'c', kind: 'prompt_delta', formatVersion: 3, name: 'C', baseId: 'b', changes: [] },
                { id: 'd', kind: 'prompt_delta', formatVersion: 3, name: 'D', baseId: 'a', changes: [] },
            ],
        } as any;
        const ids = collectDescendantProfileIds(meta, 'a');
        expect(ids.sort()).toEqual(['b', 'c', 'd']);
    });

    it('archive stubs always return false', () => {
        expect(isArchiveProfile({} as any)).toBe(false);
        expect(isArchiveProfile({ archive: true } as any)).toBe(false);
    });
});