import { describe, it, expect } from 'vitest';
import { diffSampling, diffExtra } from '../src/promptCapture.js';
import { collectProfileChain, resolveEffectiveSampling, resolveEffectiveExtra, resolveEffectiveExtToggles, applyProfileToPreset } from '../src/promptApply.js';
import { buildNewBaseProfile } from '../src/profileMutators.js';

const base = (id: string, prompts: any[] = [], opts: any = {}): any => ({
    formatVersion: 3,
    kind: 'prompt_base',
    id,
    name: 'Base',
    prompts,
    ...opts,
});

const delta = (id: string, baseId: string, opts: any = {}): any => ({
    formatVersion: 3,
    kind: 'prompt_delta',
    id,
    name: 'Delta',
    baseId,
    changes: [],
    ...opts,
});

describe('promptChain resolution', () => {
    it('resolves effective sampling as baseline ⊕ base diff ⊕ delta diff', () => {
        const b = base('b1', [], { sampling: { temperature: 0.5 } });
        const d = delta('d1', 'b1', { sampling: { top_p: 0.8 } });
        expect(resolveEffectiveSampling(d, [b, d], { temperature: 1.0, top_p: 0.9 })).toEqual({ temperature: 0.5, top_p: 0.8 });
    });

    it('falls back to factory baseline when chain has no diffs', () => {
        const b = base('b1');
        const d = delta('d1', 'b1');
        expect(resolveEffectiveSampling(d, [b, d], { temperature: 0.7 })).toEqual({ temperature: 0.7 });
        expect(resolveEffectiveSampling(d, [b, d])).toBeUndefined();
    });

    it('resolves effective extra as baseline ⊕ chain diffs', () => {
        const b = base('b1', [], { extra: { a: 1 } });
        const d = delta('d1', 'b1', { extra: { b: 2 } });
        expect(resolveEffectiveExtra(d, [b, d], { a: 0, c: 3 })).toEqual({ a: 1, b: 2, c: 3 });
    });

    it('collects chain root-first with cycle protection', () => {
        const b = base('b1');
        const d1 = delta('d1', 'b1');
        const d2 = delta('d2', 'd1');
        expect(collectProfileChain(d2, [b, d1, d2]).map((p) => p.id)).toEqual(['b1', 'd1', 'd2']);
        const cyc1 = delta('d3', 'd4');
        const cyc2 = delta('d4', 'd3');
        expect(collectProfileChain(cyc1, [cyc1, cyc2]).map((p) => p.id)).toEqual(['d4', 'd3']);
    });
});

describe('diffSampling / diffExtra', () => {
    it('keeps only keys differing from baseline', () => {
        expect(diffSampling({ temperature: 0.5, top_p: 0.9 }, { temperature: 0.5, top_p: 0.7 })).toEqual({ top_p: 0.9 });
        expect(diffSampling({ temperature: 0.5 }, { temperature: 0.5 })).toBeNull();
        expect(diffSampling(null, { temperature: 0.5 })).toBeNull();
    });

    it('diffExtra keeps only differing keys', () => {
        expect(diffExtra({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual({ b: 2 });
        expect(diffExtra({ a: 1 }, { a: 1 })).toBeNull();
        expect(diffExtra(null, { a: 1 })).toBeNull();
    });
});

describe('applyProfileToPreset sampling/extra/model chain', () => {
    it('applies factory baseline for delta without own sampling', () => {
        const preset: any = { prompts: [], prompt_order: [], temperature: 0.3 };
        const b = base('b1');
        const d = delta('d1', 'b1');
        applyProfileToPreset(preset, d, [b, d], { defaultSampling: { temperature: 0.7 } });
        expect(preset.temperature).toBe(0.7);
    });

    it('old full-snapshot delta reads identically under chain semantics', () => {
        const preset: any = { prompts: [], prompt_order: [], temperature: 1.0, top_p: 1.0 };
        const b = base('b1', [], { sampling: { temperature: 0.5 } });
        const d = delta('d1', 'b1', { sampling: { temperature: 0.9, top_p: 0.8 } });
        applyProfileToPreset(preset, d, [b, d], { defaultSampling: { temperature: 1.0, top_p: 1.0 } });
        expect(preset.temperature).toBe(0.9);
        expect(preset.top_p).toBe(0.8);
    });

    it('applies model with defaultModel fallback', () => {
        const preset: any = { prompts: [], prompt_order: [], chat_completion_source: 'openai', openai_model: 'old' };
        const b = base('b1');
        const d = delta('d1', 'b1');
        applyProfileToPreset(preset, d, [b, d], { defaultModel: { source: 'openai', name: 'gpt-4o' } });
        expect(preset.openai_model).toBe('gpt-4o');
    });

    it('resolves effective ext toggles as chain overlay with self precedence', () => {
        const b = base('b1', [], { extProfile: { extToggles: { 'regex_scripts.r1.disabled': true, 'SPreset.ChatSquash.enabled': false } } });
        const d = delta('d1', 'b1', { extProfile: { extToggles: { 'regex_scripts.r1.disabled': false } } });
        // 自身覆盖父层同名键；未覆盖的父层键继承
        expect(resolveEffectiveExtToggles(d, [b, d])).toEqual({ 'regex_scripts.r1.disabled': false, 'SPreset.ChatSquash.enabled': false });
        expect(resolveEffectiveExtToggles(b, [b])).toEqual({ 'regex_scripts.r1.disabled': true, 'SPreset.ChatSquash.enabled': false });
    });

    it('applies inherited toggles on delta but does not inherit structural mounts', () => {
        const preset: any = {
            prompts: [],
            prompt_order: [],
            extensions: { regex_scripts: [{ id: 'r1', scriptName: 'X', disabled: true }] },
            tavern_helper: {},
        };
        const b = base('b1', [], {
            extProfile: {
                extMounts: { regex_scripts: [{ id: 'r9', definition: { id: 'r9', scriptName: 'Base新增' } }] },
                extToggles: { 'regex_scripts.r1.disabled': false },
            },
        });
        const d = delta('d1', 'b1'); // 自身无任何扩展覆盖：开关继承父层，mount 不继承
        applyProfileToPreset(preset as unknown as Parameters<typeof applyProfileToPreset>[0], d as never, [b as never, d as never]);
        const scripts = (preset.extensions.regex_scripts ?? []) as Array<{ id: string; disabled?: boolean }>;
        expect(scripts.find((s) => s.id === 'r1')?.disabled).toBe(false); // 父层开关被继承应用
        expect(scripts.find((s) => s.id === 'r9')).toBeUndefined();       // 结构性 mount 不继承
    });
 });

describe('buildNewBaseProfile sparse capture', () => {
    it('stores no sampling/extra when identical to factory baseline', () => {
        const preset: any = {
            prompts: [{ identifier: 'a', enabled: true }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
            temperature: 0.7,
            impersonation_prompt: 'x',
        };
        const p = buildNewBaseProfile(preset, [], 'Base', { temperature: 0.7 }, { impersonation_prompt: 'x' });
        expect(p.sampling).toBeUndefined();
        expect(p.extra).toBeUndefined();
    });

    it('stores only differing sampling/extra keys', () => {
        const preset: any = {
            prompts: [{ identifier: 'a', enabled: true }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
            temperature: 0.9,
            top_p: 1.0,
            impersonation_prompt: 'y',
        };
        const p = buildNewBaseProfile(preset, [], 'Base', { temperature: 0.7, top_p: 1.0 }, { impersonation_prompt: 'x' });
        expect(p.sampling).toEqual({ temperature: 0.9 });
        expect(p.extra).toEqual({ impersonation_prompt: 'y' });
    });
});
