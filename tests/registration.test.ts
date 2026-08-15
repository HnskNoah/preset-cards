import { describe, it, expect } from 'vitest';
import {
    registerProfileAsPreset,
    registerProfileAsPresetIfChanged,
    findProfilePresetName,
    findRegistrationsByParent,
    unregisterProfilePreset,
    type PresetRegistry,
    type PresetNaming,
} from '../src/core/registration/register.js';
import type { PresetSnapshot } from '../src/core/domain/types.js';
import { readPresetMarker } from '../src/core/storage/marker.js';

const snapshot: PresetSnapshot = {
    name: 'Midnight',
    prompts: [{ identifier: 'p1', content: 'hi' }],
    prompt_order: [],
};

/** 内存注册表:name → preset 记录(ST 适配层将实现为 openai_settings + openai_setting_names)。 */
function memoryRegistry(): PresetRegistry {
    const map = new Map<string, Record<string, any>>();
    return {
        list: () => Object.fromEntries(map),
        upsert: (name, record) => { map.set(name, record); },
        remove: (name) => { map.delete(name); },
    };
}

/** 固定命名策略:父名 - profile名(命名规则待定,测试用占位)。 */
function fixedNaming(): PresetNaming {
    return {
        buildRegisteredName: ({ parentPresetName, profileName }) => `${parentPresetName} - ${profileName}`,
    };
}

describe('registerProfileAsPreset', () => {
    it('registers a profile as a new preset record with profile marker', () => {
        const registry = memoryRegistry();
        const result = registerProfileAsPreset(registry, {
            parentPresetName: 'Midnight',
            profileId: 'A',
            profileName: '战斗版',
            parentKey: 'Midnight',
            snapshot,
            naming: fixedNaming(),
        });

        expect(result).toEqual({ mode: 'created', name: 'Midnight - 战斗版' });
        const record = registry.list()['Midnight - 战斗版'];
        expect(record).toBeDefined();
        // 记录本体 = 快照(深拷贝),marker 为 profile 身份
        expect(record.name).toBe('Midnight');
        expect(record.prompts).toEqual(snapshot.prompts);
        const marker = readPresetMarker(record);
        expect(marker).toMatchObject({
            kind: 'profile',
            profileId: 'A',
            profileName: '战斗版',
            parentKey: 'Midnight',
        });
    });

    it('passes all existing preset names to the naming strategy (collision can be avoided)', () => {
        const registry = memoryRegistry();
        registry.upsert('Midnight - 战斗版', { name: 'other', extensions: {} });
        let seen: Set<string> | undefined;
        const spyNaming: PresetNaming = {
            buildRegisteredName: (ctx) => {
                seen = ctx.existingNames;
                return 'x';
            },
        };

        registerProfileAsPreset(registry, {
            parentPresetName: 'Midnight', profileId: 'B', profileName: '日常版', parentKey: 'Midnight',
            snapshot, naming: spyNaming,
        });

        expect(seen).toBeDefined();
        expect(seen!.has('Midnight - 战斗版')).toBe(true);
        // 策略可据此返回去重名
    });

    it('rewrites an existing registration in place keeping the same name', () => {
        const registry = memoryRegistry();
        registerProfileAsPreset(registry, {
            parentPresetName: 'Midnight', profileId: 'A', profileName: '战斗版', parentKey: 'Midnight',
            snapshot, naming: fixedNaming(),
        });

        const nextSnapshot: PresetSnapshot = { ...snapshot, prompts: [{ identifier: 'p1', content: 'updated' }] };
        const result = registerProfileAsPreset(registry, {
            parentPresetName: 'Midnight', profileId: 'A', profileName: '战斗版', parentKey: 'Midnight',
            snapshot: nextSnapshot, naming: fixedNaming(),
        });

        expect(result).toEqual({ mode: 'rewritten', name: 'Midnight - 战斗版' });
        const entries = Object.values(registry.list());
        expect(entries).toHaveLength(1); // 不产生第二条
        expect(entries[0].prompts[0].content).toBe('updated'); // 快照已更新
    });

    it('registers two distinct profiles as two separate presets', () => {
        const registry = memoryRegistry();
        registerProfileAsPreset(registry, {
            parentPresetName: 'Midnight', profileId: 'A', profileName: '战斗版', parentKey: 'Midnight',
            snapshot, naming: fixedNaming(),
        });
        registerProfileAsPreset(registry, {
            parentPresetName: 'Midnight', profileId: 'B', profileName: '日常版', parentKey: 'Midnight',
            snapshot, naming: fixedNaming(),
        });

        expect(Object.keys(registry.list())).toEqual(['Midnight - 战斗版', 'Midnight - 日常版']);
    });
});

describe('findProfilePresetName', () => {
    it('finds the registered preset name by profileId (marker-based, name-independent)', () => {
        const registry = memoryRegistry();
        registerProfileAsPreset(registry, {
            parentPresetName: 'Midnight', profileId: 'A', profileName: '战斗版', parentKey: 'Midnight',
            snapshot, naming: fixedNaming(),
        });

        expect(findProfilePresetName(registry, 'A')).toBe('Midnight - 战斗版');
        expect(findProfilePresetName(registry, 'nope')).toBeUndefined();
    });
});

describe('unregisterProfilePreset', () => {
    it('removes the registration and reports success; missing profile reports false', () => {
        const registry = memoryRegistry();
        registerProfileAsPreset(registry, {
            parentPresetName: 'Midnight', profileId: 'A', profileName: '战斗版', parentKey: 'Midnight',
            snapshot, naming: fixedNaming(),
        });

        expect(unregisterProfilePreset(registry, 'A')).toBe(true);
        expect(findProfilePresetName(registry, 'A')).toBeUndefined();
        expect(unregisterProfilePreset(registry, 'A')).toBe(false);
    });
});

describe('findRegistrationsByParent', () => {
    it('lists only registrations owned by the given parent preset', () => {
        const registry = memoryRegistry();
        registerProfileAsPreset(registry, {
            parentPresetName: 'Midnight', profileId: 'A', profileName: '战斗版', parentKey: 'Midnight',
            snapshot, naming: fixedNaming(),
        });
        registerProfileAsPreset(registry, {
            parentPresetName: 'Midnight', profileId: 'B', profileName: '日常版', parentKey: 'Midnight',
            snapshot, naming: fixedNaming(),
        });
        registerProfileAsPreset(registry, {
            parentPresetName: 'Dawn', profileId: 'X', profileName: '晨曦', parentKey: 'Dawn',
            snapshot, naming: fixedNaming(),
        });

        const owned = findRegistrationsByParent(registry, 'Midnight');
        expect(owned.map((o) => o.name)).toEqual(['Midnight - 战斗版', 'Midnight - 日常版']);
        expect(findRegistrationsByParent(registry, 'Dawn').map((o) => o.name)).toEqual(['Dawn - 晨曦']);
        expect(findRegistrationsByParent(registry, 'Nobody')).toEqual([]);
    });
});

describe('registerProfileAsPresetIfChanged', () => {
    it('returns null when the existing registration content is identical (no rewrite, no save)', () => {
        const registry = memoryRegistry();
        registerProfileAsPreset(registry, {
            parentPresetName: 'Midnight', profileId: 'A', profileName: '战斗版', parentKey: 'Midnight',
            snapshot, naming: fixedNaming(),
        });

        const result = registerProfileAsPresetIfChanged(registry, {
            parentPresetName: 'Midnight', profileId: 'A', profileName: '战斗版', parentKey: 'Midnight',
            snapshot, naming: fixedNaming(),
        });

        expect(result).toBeNull();
        expect(Object.keys(registry.list())).toHaveLength(1);
    });

    it('rewrites when snapshot content changed and creates when absent', () => {
        const registry = memoryRegistry();
        const nextSnapshot: PresetSnapshot = { ...snapshot, prompts: [{ identifier: 'p1', content: 'v2' }] };

        const created = registerProfileAsPresetIfChanged(registry, {
            parentPresetName: 'Midnight', profileId: 'A', profileName: '战斗版', parentKey: 'Midnight',
            snapshot, naming: fixedNaming(),
        });
        expect(created).toEqual({ mode: 'created', name: 'Midnight - 战斗版' });

        const rewritten = registerProfileAsPresetIfChanged(registry, {
            parentPresetName: 'Midnight', profileId: 'A', profileName: '战斗版', parentKey: 'Midnight',
            snapshot: nextSnapshot, naming: fixedNaming(),
        });
        expect(rewritten).toEqual({ mode: 'rewritten', name: 'Midnight - 战斗版' });
    });
});
