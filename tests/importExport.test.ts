import { describe, it, expect } from 'vitest';
import { classifyHeaderImport, extractProfilesFromPresetExport, isCrossPresetImport, mergeImportedProfiles, orderPresetCandidates } from '../src/importExport.js';
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
        expect(result.addedCount).toBe(0);
    });

    it('rejects a full preset export whose profiles are all invalid (no silent no-op)', () => {
        const preset = { extensions: { preset_cards: { profiles: [{ kind: 'prompt_base', formatVersion: 3, id: 1 }] } } };
        expect(() => mergeImportedProfiles(preset, [], 'Imported', {} as any)).toThrow();
    });

    it('keeps v3 payload (tree) import path working unchanged', () => {
        const tree = { kind: 'prompt_tree', formatVersion: 3, profiles: [baseProfile, deltaProfile] };
        const result = mergeImportedProfiles(tree, [], 'Imported', {} as any);
        expect(result.profiles).toHaveLength(2);
        const delta = result.profiles.find((p) => p.kind === 'prompt_delta')!;
        expect(delta.name).toBe('Imported');
    });
});

describe('mergeImportedProfiles deduplication & cross-file merge', () => {
    const chainPreset = {
        name: 'My Preset',
        prompts: [],
        extensions: { preset_cards: { profiles: [baseProfile, deltaProfile] } },
    };
    const skipWarning = (warnings: string[]) =>
        warnings.some((w) => w.includes('Duplicate configuration skipped') || w.includes('已跳过'));

    it('re-importing the same file is a no-op with a skip warning and addedCount 0', () => {
        const first = mergeImportedProfiles(chainPreset, [], 'Imported', {} as any);
        expect(first.profiles).toHaveLength(2);
        expect(first.addedCount).toBe(2);
        const second = mergeImportedProfiles(chainPreset, first.profiles, 'Imported', {} as any);
        expect(second.profiles).toEqual(first.profiles);
        expect(second.addedCount).toBe(0);
        expect(skipWarning(second.warnings)).toBe(true);
    });

    it('re-import with a different input name still dedupes by content', () => {
        const first = mergeImportedProfiles(chainPreset, [], 'Imported', {} as any);
        const second = mergeImportedProfiles(chainPreset, first.profiles, 'Renamed', {} as any);
        expect(second.profiles).toEqual(first.profiles);
    });

    it('same name but different content is NOT deduped (appended)', () => {
        const fileA = { extensions: { preset_cards: { profiles: [baseProfile] } } };
        const first = mergeImportedProfiles(fileA, [], 'X', {} as any);
        const otherBase = makeBaseProfile({
            id: 'b2',
            name: baseProfile.name, // 同名
            prompts: [{ identifier: 'a', mounted: false, enabled: true }], // 内容不同
        });
        const fileB = { extensions: { preset_cards: { profiles: [otherBase] } } };
        const second = mergeImportedProfiles(fileB, first.profiles, 'Y', {} as any);
        expect(second.profiles).toHaveLength(2);
        expect(second.warnings).toEqual([]);
    });

    it('delta file whose parent already exists in the target attaches to the existing parent (cross-file merge)', () => {
        // 第一次：导入 base-only 文件
        const baseOnly = { extensions: { preset_cards: { profiles: [baseProfile] } } };
        const first = mergeImportedProfiles(baseOnly, [], 'Imported', {} as any);
        expect(first.profiles).toHaveLength(1);
        const existingBase = first.profiles[0];

        // 第二次：导入带内嵌父状态、父不在文件内的 delta（tree 载荷，父内容与目标已有 base 相同）
        const deltaTree = {
            kind: 'prompt_tree',
            formatVersion: 3,
            profiles: [{
                kind: 'prompt_delta',
                formatVersion: 3,
                id: 'd9',
                name: 'Delta2',
                baseId: 'b9', // 不在文件内
                base: { name: 'Base', prompts: baseProfile.prompts }, // 内嵌父状态 = 已有 base 的内容
                changes: [{ identifier: 'a', enabled: false }],
            }],
        };
        const second = mergeImportedProfiles(deltaTree, first.profiles, 'Delta2', {} as any);
        // 父已存在 → 锚点被去重跳过，delta 直接挂到现有 base，不产生第二个 base
        expect(second.profiles).toHaveLength(2);
        expect(second.profiles.filter((p) => p.kind === 'prompt_base')).toHaveLength(1);
        const delta = second.profiles.find((p) => p.kind === 'prompt_delta')!;
        expect(delta.baseId).toBe(existingBase.id);
    });

    it('duplicate bases within one file are imported only once', () => {
        const dupFile = {
            extensions: { preset_cards: { profiles: [baseProfile, { ...baseProfile, id: 'bb' }] } },
        };
        const result = mergeImportedProfiles(dupFile, [], 'Imported', {} as any);
        expect(result.profiles).toHaveLength(1);
        expect(skipWarning(result.warnings)).toBe(true);
    });
});

describe('classifyHeaderImport', () => {
    it('classifies full preset exports as preset (including empty profiles)', () => {
        expect(classifyHeaderImport({ extensions: { preset_cards: { profiles: [baseProfile] } } })).toBe('preset');
        expect(classifyHeaderImport({ extensions: { preset_cards: { profiles: [] } } })).toBe('preset');
    });

    it('classifies v3 profile payloads as v3profile (base / delta / tree)', () => {
        expect(classifyHeaderImport({
            kind: 'prompt_base', formatVersion: 3, id: 'b1', name: 'Base',
            prompts: [{ identifier: 'a', mounted: true, enabled: true }],
        })).toBe('v3profile');
        expect(classifyHeaderImport({
            kind: 'prompt_delta', formatVersion: 3, id: 'd1', name: 'D', baseId: 'b1', changes: [],
        })).toBe('v3profile');
        expect(classifyHeaderImport({ kind: 'prompt_tree', formatVersion: 3, profiles: [baseProfile] })).toBe('v3profile');
    });

    it('classifies plain ST presets / legacy / junk as native', () => {
        expect(classifyHeaderImport({ name: 'P', prompts: [] })).toBe('native');
        expect(classifyHeaderImport({ formatVersion: 1, kind: 'prompt_snapshot', id: 'x', name: 'Old', prompts: [] })).toBe('native');
        expect(classifyHeaderImport({ name: 'P', extensions: { preset_cards: { profiles: 'nope' } } })).toBe('native');
        expect(classifyHeaderImport({})).toBe('native');
    });
});

describe('isCrossPresetImport', () => {
    it('same-name full preset export needs no cross-preset confirmation', () => {
        const preset = { name: 'A', prompts: [], extensions: { preset_cards: { profiles: [baseProfile] } } };
        expect(isCrossPresetImport(preset, 'A')).toBe(false);
    });

    it('different-name full preset export needs confirmation (may be another preset or renamed)', () => {
        const preset = { name: 'B', prompts: [], extensions: { preset_cards: { profiles: [baseProfile] } } };
        expect(isCrossPresetImport(preset, 'A')).toBe(true);
        expect(isCrossPresetImport({ prompts: [], extensions: { preset_cards: { profiles: [baseProfile] } } }, 'A')).toBe(true);
    });

    it('v3 profile payloads always need confirmation (no source preset identity)', () => {
        expect(isCrossPresetImport({ kind: 'prompt_base', formatVersion: 3, id: 'b1', name: 'Base', prompts: [] }, 'A')).toBe(true);
        expect(isCrossPresetImport({ kind: 'prompt_tree', formatVersion: 3, profiles: [baseProfile] }, 'A')).toBe(true);
    });
});

describe('orderPresetCandidates', () => {
    it('puts an existing same-name preset first', () => {
        expect(orderPresetCandidates(['B', 'A', 'C'], 'A')).toEqual(['A', 'B', 'C']);
    });

    it('does not fabricate a same-name option when no preset has that name', () => {
        expect(orderPresetCandidates(['B', 'C'], 'A')).toEqual(['B', 'C']);
    });

    it('returns a copy of the original list without preferredFirst', () => {
        expect(orderPresetCandidates(['B', 'A'])).toEqual(['B', 'A']);
        expect(orderPresetCandidates([])).toEqual([]);
    });
});
