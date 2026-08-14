import { describe, it, expect } from 'vitest';
import { extractProfilesFromPresetExport, mergeImportedProfiles } from '../src/importExport.js';
import { makeBaseProfile, makeDeltaProfile } from '../src/profileActions.js';

const baseProfile = makeBaseProfile({
    id: 'b1',
    name: 'Base',
    prompts: [{ identifier: 'a', mounted: true, enabled: true, lastActiveIndex: 0 }],
});

const deltaProfile = makeDeltaProfile({
    id: 'd1',
    name: 'Delta',
    baseId: 'b1',
    changes: [{ identifier: 'a', enabled: false }],
    order: ['a'],
});

describe('extractProfilesFromPresetExport', () => {
    it('extracts v3 profiles from a full preset export (extensions.preset_cards)', () => {
        const preset = {
            name: 'My Preset',
            prompts: [],
            extensions: { preset_cards: { profiles: [baseProfile, deltaProfile] } },
        };
        const result = extractProfilesFromPresetExport(preset);
        expect(result).toHaveLength(2);
        expect(result?.[0].id).toBe('b1');
        expect(result?.[1].id).toBe('d1');
    });

    it('filters out non-v3 profiles (v1/v2) from a full preset export', () => {
        const preset = {
            extensions: {
                preset_cards: {
                    profiles: [
                        baseProfile,
                        { formatVersion: 1, kind: 'prompt_snapshot', id: 'old', name: 'Old', prompts: [] },
                    ],
                },
            },
        };
        const result = extractProfilesFromPresetExport(preset);
        expect(result).toHaveLength(1);
        expect(result?.[0].id).toBe('b1');
    });

    it('returns undefined for v3 payloads (base / delta / tree)', () => {
        expect(extractProfilesFromPresetExport({ kind: 'prompt_base', formatVersion: 3, profiles: [] })).toBeUndefined();
        expect(extractProfilesFromPresetExport({ kind: 'prompt_delta', formatVersion: 3, changes: [] })).toBeUndefined();
        expect(extractProfilesFromPresetExport({ kind: 'prompt_tree', formatVersion: 3, profiles: [] })).toBeUndefined();
    });

    it('returns undefined for presets without preset_cards extension', () => {
        expect(extractProfilesFromPresetExport({ name: 'P', prompts: [] })).toBeUndefined();
        expect(extractProfilesFromPresetExport({})).toBeUndefined();
    });
});

describe('mergeImportedProfiles from full preset export', () => {
    it('merges profiles from a full preset export into existing profiles', () => {
        const preset = {
            name: 'My Preset',
            prompts: [],
            extensions: { preset_cards: { profiles: [baseProfile, deltaProfile] } },
        };
        const result = mergeImportedProfiles(preset, [], 'Imported', {} as any);
        expect(result.warnings).toEqual([]);
        expect(result.profiles).toHaveLength(2);
        // id 重新分配，baseId 通过 idMap 重映射
        const base = result.profiles.find((p) => p.kind === 'prompt_base')!;
        const delta = result.profiles.find((p) => p.kind === 'prompt_delta')!;
        expect(base.id).not.toBe('b1');
        expect(delta.baseId).toBe(base.id);
        expect(delta.name).toBe('Imported');
    });

    it('accepts a full preset export with empty profiles as a no-op merge', () => {
        const preset = { extensions: { preset_cards: { profiles: [] } } };
        const existing = [baseProfile];
        const result = mergeImportedProfiles(preset, existing, 'Imported', {} as any);
        expect(result.profiles).toEqual(existing);
        expect(result.warnings).toEqual([]);
    });

    it('keeps v3 payload (tree) import path working unchanged', () => {
        const tree = { kind: 'prompt_tree', formatVersion: 3, profiles: [baseProfile, deltaProfile] };
        const result = mergeImportedProfiles(tree, [], 'Imported', {} as any);
        expect(result.profiles).toHaveLength(2);
        const delta = result.profiles.find((p) => p.kind === 'prompt_delta')!;
        expect(delta.name).toBe('Imported');
    });
});
