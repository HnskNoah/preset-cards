import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyProfileToPreset } from '../src/promptApply.js';
import { resetProfileCore } from '../src/profileMutators.js';
import { addPreset } from './mocks/openai.js';

const base = (id: string, prompts: any[], opts: { sampling?: any; extra?: any; model?: any } = {}): any => ({
    formatVersion: 3,
    kind: 'prompt_base',
    id,
    name: 'Base',
    prompts,
    ...(opts.sampling ? { sampling: opts.sampling } : {}),
    ...(opts.extra ? { extra: opts.extra } : {}),
    ...(opts.model ? { model: opts.model } : {}),
});

const delta = (id: string, baseId: string, opts: { sampling?: any; extra?: any } = {}): any => ({
    formatVersion: 3,
    kind: 'prompt_delta',
    id,
    name: 'Delta',
    baseId,
    changes: [],
    ...(opts.sampling ? { sampling: opts.sampling } : {}),
    ...(opts.extra ? { extra: opts.extra } : {}),
});

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true } as Response)));
});

describe('applyProfileToPreset', () => {
    it('does not clear prompt_order when a base resolves to zero entries', () => {
        const preset: any = {
            prompts: [{ identifier: 'a', enabled: true, name: 'A' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
        };
        const profiles = [base('b1', [])];
        applyProfileToPreset(preset, profiles[0], profiles);
        const order = preset.prompt_order.find((l: any) => String(l.character_id) === '100001');
        expect(order.order).toEqual([{ identifier: 'a', enabled: true }]);
    });

    it('restores defaultSnapshot.originalFields before applying a profile without sparse fields', () => {
        const preset: any = {
            prompts: [{ identifier: 'a', enabled: true, content: 'default' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
        };
        const defaultSnapshot = [{ identifier: 'a', mounted: true, enabled: true, originalFields: { content: 'default' } }];
        const b2 = base('b2', [{ identifier: 'a', mounted: true, enabled: true, fields: { content: 'B2' } }]);
        const b1 = base('b1', [{ identifier: 'a', mounted: true, enabled: true }]);

        applyProfileToPreset(preset, b2, [b1, b2], { defaultSnapshot });
        expect(preset.prompts[0].content).toBe('B2');
        applyProfileToPreset(preset, b1, [b1, b2], { defaultSnapshot });
        // B1 无 fields → 应回到出厂基线值，而不是残留 B2
        expect(preset.prompts[0].content).toBe('default');
    });
});

describe('resetProfileCore (delta)', () => {
    it('resets sampling to the parent chain value, not the factory default', async () => {
        const parent = base('b1', [{ identifier: 'a', mounted: true, enabled: true }], { sampling: { temperature: 0.5 } });
        const child = delta('d1', 'b1', { sampling: { temperature: 0.9 } });
        const meta: any = {
            description: '',
            models: [],
            bgImage: '',
            profiles: [parent, child],
            defaultSnapshot: [{ identifier: 'a', mounted: true, enabled: true }],
            defaultSnapshotLocked: true,
            defaultSampling: { temperature: 1.0 },
        };
        const preset: any = {
            temperature: 0.9,
            prompts: [{ identifier: 'a', enabled: true }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
            extensions: {},
        };
        const result = await resetProfileCore(preset, meta, child, 'Test', 0);
        expect(result).toBe('reset');
        expect(preset.temperature).toBe(0.5);
        // 自身差异清空：继承父链解析态（加载时链式解析还原）
        expect(child.sampling).toBeUndefined();
    });

    it('resets extra to the parent chain value', async () => {
        const parent = base('b1', [{ identifier: 'a', mounted: true, enabled: true }], { extra: { impersonation_prompt: 'parent' } });
        const child = delta('d1', 'b1', { extra: { impersonation_prompt: 'child' } });
        const meta: any = {
            description: '',
            models: [],
            bgImage: '',
            profiles: [parent, child],
            defaultSnapshot: [{ identifier: 'a', mounted: true, enabled: true }],
            defaultSnapshotLocked: true,
            defaultExtra: { impersonation_prompt: 'default' },
        };
        const preset: any = {
            impersonation_prompt: 'child',
            prompts: [{ identifier: 'a', enabled: true }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
            extensions: {},
        };
        await resetProfileCore(preset, meta, child, 'Test', 0);
        expect(preset.impersonation_prompt).toBe('parent');
        expect(child.extra).toBeUndefined();
    });

    it('falls back to factory default when parent has no sampling', async () => {
        const parent = base('b1', [{ identifier: 'a', mounted: true, enabled: true }]);
        const child = delta('d1', 'b1', { sampling: { temperature: 0.9 } });
        const meta: any = {
            description: '',
            models: [],
            bgImage: '',
            profiles: [parent, child],
            defaultSnapshot: [{ identifier: 'a', mounted: true, enabled: true }],
            defaultSnapshotLocked: true,
            defaultSampling: { temperature: 1.0 },
        };
        const preset: any = {
            temperature: 0.9,
            prompts: [{ identifier: 'a', enabled: true }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
            extensions: {},
        };
        await resetProfileCore(preset, meta, child, 'Test', 0);
        expect(preset.temperature).toBe(1.0);
        expect(child.sampling).toBeUndefined();
    });

    it('does not mutate live profile or preset when save fails', async () => {
        vi.useFakeTimers();
        const profile = base('b1', [{ identifier: 'a', mounted: true, enabled: true, fields: { content: 'B1' } }]);
        const meta: any = {
            description: '',
            models: [],
            bgImage: '',
            profiles: [profile],
            defaultSnapshot: [{ identifier: 'a', mounted: true, enabled: true, originalFields: { content: 'default' } }],
            defaultSnapshotLocked: true,
            defaultSampling: { temperature: 1.0 },
        };
        const preset: any = {
            temperature: 0.5,
            prompts: [{ identifier: 'a', enabled: true, content: 'B1' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
            extensions: {},
        };
        const originalPrompts = structuredClone(profile.prompts);
        const originalContent = preset.prompts[0].content;
        const failFetch = vi.fn(async () => ({ ok: false } as Response));
        vi.stubGlobal('fetch', failFetch);
        const idx = addPreset('Test', preset);

        const p = resetProfileCore(preset, meta, profile, 'Test', idx);
        await vi.runAllTimersAsync();
        console.log('S2 debug fetch calls:', failFetch.mock.calls.length);
        await expect(p).resolves.not.toBe('reset');

        expect(profile.prompts).toEqual(originalPrompts);
        expect(preset.prompts[0].content).toBe(originalContent);
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });
});
