// extApply.test.ts：扩展 mount/unmount/toggle 应用测试
import { describe, it, expect } from 'vitest';
import { applyExtensions, buildInheritedExtensionBaseline } from '../src/extApply.js';
import { computeExtensionDrift } from '../src/extCapture.js';

describe('applyExtensions', () => {
    it('mounts an item to an existing array', () => {
        const preset = {
            extensions: {
                regex_scripts: [],
            },
        };
        applyExtensions(preset, {
            extMounts: {
                'regex_scripts': [{
                    id: 'abc-123',
                    definition: { id: 'abc-123', findRegex: 'test', disabled: false },
                }],
            },
        });
        expect(preset.extensions.regex_scripts).toHaveLength(1);
        expect(preset.extensions.regex_scripts[0].id).toBe('abc-123');
        expect(preset.extensions.regex_scripts[0].findRegex).toBe('test');
    });

    it('unmounts items from an array by id', () => {
        const preset = {
            extensions: {
                regex_scripts: [
                    { id: 'r1', findRegex: 'a', disabled: false },
                    { id: 'r2', findRegex: 'b', disabled: true },
                    { id: 'r3', findRegex: 'c', disabled: false },
                ],
            },
        };
        applyExtensions(preset, {
            extUnmounts: {
                'regex_scripts': ['r2'],
            },
        });
        expect(preset.extensions.regex_scripts).toHaveLength(2);
        expect(preset.extensions.regex_scripts.map((x: any) => x.id)).toEqual(['r1', 'r3']);
    });

    it('toggles a simple boolean field', () => {
        const preset = {
            extensions: {
                SPreset: {
                    ChatSquash: { enabled: false },
                },
            },
        };
        applyExtensions(preset, {
            extToggles: {
                'SPreset.ChatSquash.enabled': true,
            },
        });
        expect(preset.extensions.SPreset.ChatSquash.enabled).toBe(true);
    });

    it('toggles disabled on an array item by id', () => {
        const preset = {
            extensions: {
                regex_scripts: [
                    { id: 'r1', findRegex: 'a', disabled: false },
                    { id: 'r2', findRegex: 'b', disabled: true },
                ],
            },
        };
        applyExtensions(preset, {
            extToggles: {
                'regex_scripts.r1.disabled': true,
            },
        });
        expect(preset.extensions.regex_scripts[0].disabled).toBe(true);
        expect(preset.extensions.regex_scripts[1].disabled).toBe(true); // r2 unchanged
    });

    it('toggles enabled on an array item by id', () => {
        const preset = {
            extensions: {
                tavern_helper: {
                    scripts: [
                        { id: 's1', name: 'script1', enabled: true },
                        { id: 's2', name: 'script2', enabled: false },
                    ],
                },
            },
        };
        applyExtensions(preset, {
            extToggles: {
                'tavern_helper.scripts.s1.enabled': false,
            },
        });
        expect(preset.extensions.tavern_helper.scripts[0].enabled).toBe(false);
        expect(preset.extensions.tavern_helper.scripts[1].enabled).toBe(false); // s2 unchanged
    });

    it('mount and unmount on the same path', () => {
        const preset = {
            extensions: {
                regex_scripts: [
                    { id: 'r1', findRegex: 'a', disabled: false },
                ],
            },
        };
        applyExtensions(preset, {
            extMounts: {
                'regex_scripts': [{
                    id: 'r-new',
                    definition: { id: 'r-new', findRegex: 'new', disabled: false },
                }],
            },
            extUnmounts: {
                'regex_scripts': ['r1'],
            },
        });
        // unmount 先执行，移除 r1；然后 mount 加上 r-new
        expect(preset.extensions.regex_scripts).toHaveLength(1);
        expect(preset.extensions.regex_scripts[0].id).toBe('r-new');
    });

    it('does nothing when extProfile is undefined', () => {
        const preset = { extensions: { regex_scripts: [{ id: 'r1' }] } };
        const original = structuredClone(preset);
        applyExtensions(preset, undefined);
        expect(preset).toEqual(original);
    });

    it('does nothing when extProfile is empty', () => {
        const preset = { extensions: { regex_scripts: [{ id: 'r1' }] } };
        const original = structuredClone(preset);
        applyExtensions(preset, {});
        expect(preset).toEqual(original);
    });

    it('overrides an existing entry definition when mounted again (cross-layer last-writer-wins)', () => {
        const preset = { extensions: { regex_scripts: [{ id: 'x1', content: 'old', disabled: false }] } };
        applyExtensions(preset, {
            extMounts: { regex_scripts: [{ id: 'x1', definition: { id: 'x1', content: 'new', disabled: false } }] },
        });
        expect(preset.extensions.regex_scripts).toHaveLength(1);
        expect(preset.extensions.regex_scripts[0].content).toBe('new');
    });

    it('buildInheritedExtensionBaseline applies ancestor layers onto a clone without mutating parent', () => {
        const parent = { extensions: { regex_scripts: [] as any[] } };
        const baseline = buildInheritedExtensionBaseline(parent, [
            { extProfile: { extMounts: { regex_scripts: [{ id: 'a', definition: { id: 'a' } }] } } },
        ]);
        expect((baseline.extensions.regex_scripts as any[]).map((s) => s.id)).toEqual(['a']);
        expect(parent.extensions.regex_scripts).toHaveLength(0);
    });

    it('round-trips toggles for array ids containing dots', () => {
        const runtime = {
            extensions: {
                regex_scripts: [{ id: 'script.v2', findRegex: 'a', disabled: true }],
            },
        };
        const parent = {
            extensions: {
                regex_scripts: [{ id: 'script.v2', findRegex: 'a', disabled: false }],
            },
        };
        const drift = computeExtensionDrift(runtime, parent);
        expect(drift).toEqual({ extToggles: { 'regex_scripts.script.v2.disabled': true } });

        const applied = structuredClone(parent);
        applyExtensions(applied, drift!);
        expect(applied.extensions.regex_scripts[0].disabled).toBe(true);
    });
});