// extCapture.test.ts：扩展 mount/unmount/toggle 漂移检测测试
import { describe, it, expect } from 'vitest';
import { computeExtensionDrift } from '../src/extCapture.js';

describe('computeExtensionDrift', () => {
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