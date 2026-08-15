import { describe, it, expect, beforeEach } from 'vitest';
import { resetOpenaiMock, addPreset, openai_settings, openai_setting_names } from './mocks/openai.js';
import { eventSource, event_types } from './mocks/events.js';
import {
    buildRegisteredSnapshots,
    syncPresetRegistrations,
    findRegisteredPresetName,
    refreshRegisteredSnapshot,
    resolveFreshRegisteredRecord,
    deriveActiveProfileRef,
    initRegisteredPresetActivation,
    initRegisteredPresetObserver,
    onActiveProfileChangedBySwitch,
} from '../src/presetRegistration.js';
import { getActiveProfile, setActiveProfile } from '../src/activeProfile.js';
import { readPresetMarker } from '../src/core/storage/marker.js';

/** 最小带 meta 的预设：一个 base profile + 一个 prompt + 采样字段。 */
function samplePreset(): Record<string, any> {
    return {
        name: 'Midnight',
        prompts: [{ identifier: 'p1', content: 'hi', role: 'system', system_prompt: false, marker: false }],
        prompt_order: [{ name: 'main', order: [{ identifier: 'p1', enabled: true }] }],
        temperature: 0.7,
        extensions: {
            preset_cards: {
                description: '',
                models: [],
                bgImage: '',
                profiles: [{
                    formatVersion: 3,
                    kind: 'prompt_base',
                    id: 'A',
                    name: '战斗版',
                    prompts: [{ identifier: 'p1', mounted: true, enabled: true }],
                }],
                defaultSnapshotLocked: true,
                defaultSnapshot: [{ identifier: 'p1', mounted: true, enabled: true, originalFields: { content: 'hi' } }],
            },
        },
    };
}

beforeEach(() => resetOpenaiMock());

describe('buildRegisteredSnapshots', () => {
    it('resolves a full preset snapshot with the profile applied (sampling fields preserved)', () => {
        const snaps = buildRegisteredSnapshots(samplePreset() as any);

        expect(snaps).toHaveLength(1);
        expect(snaps[0].profileId).toBe('A');
        expect(snaps[0].profileName).toBe('战斗版');
        expect(snaps[0].snapshot.temperature).toBe(0.7); // 全量字段（采样等）保留
        expect(snaps[0].snapshot.prompts[0].content).toBe('hi');
    });
});

describe('syncPresetRegistrations', () => {
    it('registers all profiles and reports touched; repeats are no-ops', () => {
        const idx = addPreset('Midnight', samplePreset());

        expect(syncPresetRegistrations('Midnight', idx)).toBe(true);
        const regName = findRegisteredPresetName('A');
        expect(regName).toBe('Midnight - 战斗版');

        const record = openai_settings[openai_setting_names[regName!]];
        expect(readPresetMarker(record)).toMatchObject({
            kind: 'profile',
            profileId: 'A',
            profileName: '战斗版',
            parentKey: 'Midnight',
        });

        // 内容未变：对账返回 false（不触发 saveSettingsDebounced）
        expect(syncPresetRegistrations('Midnight', idx)).toBe(false);
    });

    it('unregisters orphaned registrations when a profile is deleted', () => {
        const idx = addPreset('Midnight', samplePreset());
        syncPresetRegistrations('Midnight', idx);
        expect(findRegisteredPresetName('A')).toBe('Midnight - 战斗版');

        // 模拟 profile 删除后 meta 已更新
        const preset = openai_settings[idx] as Record<string, any>;
        preset.extensions.preset_cards.profiles = [];

        expect(syncPresetRegistrations('Midnight', idx)).toBe(true);
        expect(findRegisteredPresetName('A')).toBeUndefined();
        expect(openai_setting_names['Midnight - 战斗版']).toBeUndefined();
    });
});

describe('refreshRegisteredSnapshot', () => {
    it('rewrites the registration with the latest resolution and keeps the name', () => {
        const idx = addPreset('Midnight', samplePreset());
        syncPresetRegistrations('Midnight', idx);

        // 更新 profile 内容后刷新
        const preset = openai_settings[idx] as Record<string, any>;
        preset.extensions.preset_cards.profiles[0].prompts[0].fields = { content: 'v2' };

        const name = refreshRegisteredSnapshot('Midnight', preset as any, 'A');
        expect(name).toBe('Midnight - 战斗版');
        const record = openai_settings[openai_setting_names[name!]];
        expect(record.prompts[0].content).toBe('v2');
    });
});

describe('切片 2：激活同步', () => {
    beforeEach(() => setActiveProfile(undefined));

    it('resolveFreshRegisteredRecord returns the latest full resolution (sampling preserved)', () => {
        const idx = addPreset('Midnight', samplePreset());
        syncPresetRegistrations('Midnight', idx);
        const preset = openai_settings[idx] as Record<string, any>;
        preset.extensions.preset_cards.profiles[0].prompts[0].fields = { content: 'v2' };

        const fresh = resolveFreshRegisteredRecord('Midnight', 'A');
        expect(fresh?.prompts[0].content).toBe('v2');
        expect(fresh?.temperature).toBe(0.7);
        // 关键回归：必须返回投影记录（带 marker），不能是裸快照（裸快照会抹掉 marker）
        expect(readPresetMarker(fresh)?.kind).toBe('profile');
        expect(readPresetMarker(fresh)?.profileId).toBe('A');
        expect(resolveFreshRegisteredRecord('Nobody', 'A')).toBeUndefined();
    });

    it('deriveActiveProfileRef maps a profile-registered preset to its parent ref', () => {
        const idx = addPreset('Midnight', samplePreset());
        syncPresetRegistrations('Midnight', idx);
        const regName = 'Midnight - 战斗版';
        const regIdx = openai_setting_names[regName];

        expect(deriveActiveProfileRef(regName, openai_settings[regIdx])).toEqual({ presetName: 'Midnight', profileId: 'A' });
        expect(deriveActiveProfileRef('Plain', { name: 'Plain', extensions: {} })).toBeUndefined();
        expect(deriveActiveProfileRef('Any', undefined)).toBeUndefined();
    });

    it('PRESET_CHANGED observer syncs activeProfile and notifies; plain preset clears', async () => {
        const idx = addPreset('Midnight', samplePreset());
        syncPresetRegistrations('Midnight', idx);
        const regName = 'Midnight - 战斗版';
        initRegisteredPresetObserver();

        const refs: ({ presetName: string; profileId: string } | undefined)[] = [];
        const unsub = onActiveProfileChangedBySwitch((r) => refs.push(r));

        await eventSource.emit(event_types.PRESET_CHANGED, { apiId: 'openai', name: regName });
        expect(getActiveProfile()).toEqual({ presetName: 'Midnight', profileId: 'A' });
        expect(refs[0]).toEqual({ presetName: 'Midnight', profileId: 'A' });

        addPreset('Plain', { name: 'Plain', extensions: {} });
        await eventSource.emit(event_types.PRESET_CHANGED, { apiId: 'openai', name: 'Plain' });
        expect(getActiveProfile()).toBeUndefined();
        expect(refs[1]).toBeUndefined();
        unsub();
    });

    it('BEFORE hook re-resolves and overwrites the incoming registered preset before apply', async () => {
        const idx = addPreset('Midnight', samplePreset());
        syncPresetRegistrations('Midnight', idx);
        const regName = 'Midnight - 战斗版';
        const regIdx = openai_setting_names[regName];
        initRegisteredPresetActivation();

        // 父预设 profile 内容变化 → 注册记录过期
        const preset = openai_settings[idx] as Record<string, any>;
        preset.extensions.preset_cards.profiles[0].prompts[0].fields = { content: 'v2' };

        const incoming = structuredClone(openai_settings[regIdx]); // 原生路径：克隆体
        const arg = { preset: incoming, presetName: regName, settings: {}, presetNameBefore: null };
        await eventSource.emit(event_types.OAI_PRESET_CHANGED_BEFORE, arg);

        expect(arg.preset.prompts[0].content).toBe('v2');            // 应用前已覆盖为最新解析
        expect(openai_settings[regIdx].prompts[0].content).toBe('v2'); // 存储记录同步新鲜
        // 关键回归：写回存储的记录必须保留 marker（否则卡片排除/捕获门失效）
        expect(readPresetMarker(openai_settings[regIdx])?.kind).toBe('profile');
        expect(readPresetMarker(arg.preset)?.kind).toBe('profile');
    });
});
