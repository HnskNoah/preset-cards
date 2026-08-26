// extCapture.test.ts：扩展 mount/unmount/toggle 漂移检测测试
import { describe, it, expect } from 'vitest';
import { computeExtensionDrift } from '../src/extCapture.js';

describe('computeExtensionDrift', () => {
    it('treats absent disabled as false / absent enabled as true (no ghost toggle on equivalent states)', () => {
        // runtime 显式 disabled:false vs 父未写入该字段 = 等价的「未禁用」状态，不得产生 toggle
        const runtime = {
            extensions: {
                regex_scripts: [{ id: 'r1', disabled: false }],
            },
        };
        const parent = {
            extensions: {
                regex_scripts: [{ id: 'r1' }],
            },
        };
        expect(computeExtensionDrift(runtime, parent)).toBeNull();

        // runtime 未写 enabled vs 父 enabled:true = 等价的「启用」状态
        expect(computeExtensionDrift(
            { extensions: { regex_scripts: [{ id: 'r1', enabled: true }] } },
            { extensions: { regex_scripts: [{ id: 'r1' }] } },
        )).toBeNull();

        // 真翻转仍要检出：父 disabled:true → runtime 显式 false
        const flipped = computeExtensionDrift(
            { extensions: { regex_scripts: [{ id: 'r1', disabled: false }] } },
            { extensions: { regex_scripts: [{ id: 'r1', disabled: true }] } },
        );
        expect(flipped!.extToggles!['regex_scripts.r1.disabled']).toBe(false);
    });

    it('recaptures a definition edit on an inherited entry as an overriding mount', () => {
        const drift = computeExtensionDrift(
            { extensions: { regex_scripts: [{ id: 'r1', findRegex: 'edited', disabled: false }] } },
            { extensions: { regex_scripts: [{ id: 'r1', findRegex: 'orig', disabled: false }] } },
        );
        expect(drift!.extMounts!['regex_scripts']).toEqual([
            { id: 'r1', definition: { id: 'r1', findRegex: 'edited', disabled: false } },
        ]);
        expect(drift!.extToggles).toBeUndefined();
    });

    it('still records pure toggle flips as toggles, not mounts', () => {
        const drift = computeExtensionDrift(
            { extensions: { regex_scripts: [{ id: 'r1', findRegex: 'same', disabled: true }] } },
            { extensions: { regex_scripts: [{ id: 'r1', findRegex: 'same', disabled: false }] } },
        );
        expect(drift!.extToggles!['regex_scripts.r1.disabled']).toBe(true);
        expect(drift!.extMounts).toBeUndefined();
    });

    it('detects a mounted item (in runtime but not in parent)', () => {
        const runtime = {
            extensions: {
                regex_scripts: [
                    { id: 'r1', findRegex: 'a', disabled: false },
                    { id: 'r2', findRegex: 'b', disabled: true },
                ],
            },
        };
        const parent = {
            extensions: {
                regex_scripts: [
                    { id: 'r1', findRegex: 'a', disabled: false },
                ],
            },
        };
        const result = computeExtensionDrift(runtime, parent);
        expect(result).not.toBeNull();
        expect(result!.extMounts).toBeDefined();
        expect(result!.extMounts!['regex_scripts']).toHaveLength(1);
        expect(result!.extMounts!['regex_scripts'][0].id).toBe('r2');
        expect(result!.extUnmounts).toBeUndefined();
        expect(result!.extToggles).toBeUndefined();
    });

    it('detects an unmounted item (in parent but not in runtime)', () => {
        const runtime = {
            extensions: {
                regex_scripts: [
                    { id: 'r1', findRegex: 'a', disabled: false },
                ],
            },
        };
        const parent = {
            extensions: {
                regex_scripts: [
                    { id: 'r1', findRegex: 'a', disabled: false },
                    { id: 'r2', findRegex: 'b', disabled: true },
                ],
            },
        };
        const result = computeExtensionDrift(runtime, parent);
        expect(result).not.toBeNull();
        expect(result!.extUnmounts).toBeDefined();
        expect(result!.extUnmounts!['regex_scripts']).toEqual(['r2']);
        expect(result!.extMounts).toBeUndefined();
        expect(result!.extToggles).toBeUndefined();
    });

    it('detects a disabled toggle on a shared array item', () => {
        const runtime = {
            extensions: {
                regex_scripts: [
                    { id: 'r1', findRegex: 'a', disabled: true },
                    { id: 'r2', findRegex: 'b', disabled: false },
                ],
            },
        };
        const parent = {
            extensions: {
                regex_scripts: [
                    { id: 'r1', findRegex: 'a', disabled: false },
                    { id: 'r2', findRegex: 'b', disabled: false },
                ],
            },
        };
        const result = computeExtensionDrift(runtime, parent);
        expect(result).not.toBeNull();
        expect(result!.extToggles).toBeDefined();
        expect(result!.extToggles!['regex_scripts.r1.disabled']).toBe(true);
        expect(result!.extMounts).toBeUndefined();
        expect(result!.extUnmounts).toBeUndefined();
    });

    it('detects an enabled toggle on tavern_helper script items', () => {
        const runtime = {
            extensions: {
                tavern_helper: {
                    scripts: [
                        { id: 's1', name: 'script1', enabled: false },
                        { id: 's2', name: 'script2', enabled: true },
                    ],
                },
            },
        };
        const parent = {
            extensions: {
                tavern_helper: {
                    scripts: [
                        { id: 's1', name: 'script1', enabled: true },
                        { id: 's2', name: 'script2', enabled: true },
                    ],
                },
            },
        };
        const result = computeExtensionDrift(runtime, parent);
        expect(result).not.toBeNull();
        expect(result!.extToggles).toBeDefined();
        expect(result!.extToggles!['tavern_helper.scripts.s1.enabled']).toBe(false);
        // s2.enabled 未变，不应出现在 toggle 中
        expect(result!.extToggles!['tavern_helper.scripts.s2.enabled']).toBeUndefined();
        expect(result!.extMounts).toBeUndefined();
        expect(result!.extUnmounts).toBeUndefined();
    });

    it('detects a simple boolean toggle (SPreset.ChatSquash.enabled)', () => {
        const runtime = {
            extensions: {
                SPreset: { ChatSquash: { enabled: true } },
            },
        };
        const parent = {
            extensions: {
                SPreset: { ChatSquash: { enabled: false } },
            },
        };
        const result = computeExtensionDrift(runtime, parent);
        expect(result).not.toBeNull();
        expect(result!.extToggles).toBeDefined();
        expect(result!.extToggles!['SPreset.ChatSquash.enabled']).toBe(true);
        expect(result!.extMounts).toBeUndefined();
        expect(result!.extUnmounts).toBeUndefined();
    });

    it('returns null when no drift (runtime equals parent)', () => {
        const runtime = {
            extensions: {
                regex_scripts: [{ id: 'r1', findRegex: 'a', disabled: false }],
            },
        };
        const parent = {
            extensions: {
                regex_scripts: [{ id: 'r1', findRegex: 'a', disabled: false }],
            },
        };
        const result = computeExtensionDrift(runtime, parent);
        expect(result).toBeNull();
    });

    it('detects drift on nested path array (SPreset.RegexBinding.regexes)', () => {
        const runtime = {
            extensions: {
                SPreset: {
                    RegexBinding: {
                        regexes: [
                            { id: 'x1', disabled: false },
                            { id: 'x2', disabled: true },
                        ],
                    },
                },
            },
        };
        const parent = {
            extensions: {
                SPreset: {
                    RegexBinding: {
                        regexes: [
                            { id: 'x1', disabled: false },
                        ],
                    },
                },
            },
        };
        const result = computeExtensionDrift(runtime, parent);
        expect(result).not.toBeNull();
        expect(result!.extMounts).toBeDefined();
        expect(result!.extMounts!['SPreset.RegexBinding.regexes']).toHaveLength(1);
        expect(result!.extMounts!['SPreset.RegexBinding.regexes'][0].id).toBe('x2');
    });
});