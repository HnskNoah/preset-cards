import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetOpenaiMock, addPreset, openai_settings, openai_setting_names, oai_settings } from './mocks/openai.js';
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
    initPresetRegistration,
    syncAllPresetRegistrations,
    refreshProjectionRuntimeIfActive,
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

beforeEach(() => {
    resetOpenaiMock();
    // upsert/remove 现在会 POST /api/presets/save|delete（文件型持久化），stub 掉网络
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true } as Response)));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

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

describe('PRESET_DELETED cleanup', () => {
    it('unregisters the parent preset\u2019s projections when deleted natively', async () => {
        const idx = addPreset('Midnight', samplePreset());
        syncPresetRegistrations('Midnight', idx);
        expect(findRegisteredPresetName('A')).toBe('Midnight - 战斗版');

        initPresetRegistration();
        await eventSource.emit(event_types.PRESET_DELETED, { apiId: 'openai', name: 'Midnight' });

        expect(findRegisteredPresetName('A')).toBeUndefined();
    });
});

describe('syncAllPresetRegistrations', () => {
    it('sweeps orphan projections whose parent preset is gone (startup cleanup)', () => {
        const idx = addPreset('Midnight', samplePreset());
        syncPresetRegistrations('Midnight', idx);
        expect(findRegisteredPresetName('A')).toBe('Midnight - 战斗版');

        // 父预设被原生删除：清 openai_setting_names,数组槽残留(与 ST 原生删除一致)
        delete openai_setting_names['Midnight'];

        syncAllPresetRegistrations();
        expect(findRegisteredPresetName('A')).toBeUndefined();
    });
});

describe('refreshProjectionRuntimeIfActive (NEW-2)', () => {
    it('re-applies the projection when it is the active preset (runtime kept in sync)', async () => {
        vi.stubGlobal('document', { querySelector: () => null }); // fastApplyPreset 的 DOM 写入兜底
        try {
            const idx = addPreset('Midnight', samplePreset());
            syncPresetRegistrations('Midnight', idx);
            const regName = 'Midnight - 战斗版';
            const regIdx = openai_setting_names[regName];
            // 激活投影：运行时 = 旧记录
            oai_settings.preset_settings_openai = regName;
            oai_settings.prompts = structuredClone((openai_settings[regIdx] as any).prompts);
            oai_settings.prompt_order = structuredClone((openai_settings[regIdx] as any).prompt_order);

            // 父预设 profile 内容变化(模拟编辑器提交) → 刷新投影记录
            const preset = openai_settings[idx] as Record<string, any>;
            preset.extensions.preset_cards.profiles[0].prompts[0].fields = { content: 'v2' };
            refreshRegisteredSnapshot('Midnight', preset as any, 'A');

            refreshProjectionRuntimeIfActive('Midnight');
            await new Promise((r) => setImmediate(r)); // fastApply 为 void

            expect((oai_settings.prompts as any[]).find((p: any) => p.identifier === 'p1').content).toBe('v2');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('no-op when the projection is not the active preset', async () => {
        const idx = addPreset('Midnight', samplePreset());
        syncPresetRegistrations('Midnight', idx);
        oai_settings.preset_settings_openai = 'Midnight';
        // 守卫：活动预设是无 marker 的父预设 → 不得触发重应用，运行时 prompts 保持哨兵值
        (oai_settings as any).prompts = [{ identifier: 'sentinel', content: 'untouched' }];
        refreshProjectionRuntimeIfActive('Midnight');
        await new Promise((r) => setImmediate(r)); // fastApply 为 void 异步
        expect(oai_settings.preset_settings_openai).toBe('Midnight');
        expect((oai_settings as any).prompts).toEqual([{ identifier: 'sentinel', content: 'untouched' }]);
    });
});

describe('注册持久化与启动对账（C1）', () => {
    it('SETTINGS_LOADED 触发全量对账：reload 后投影被重新注册', async () => {
        initPresetRegistration();
        addPreset('Midnight', samplePreset()); // 模拟 reload：数组只有父预设
        expect(findRegisteredPresetName('A', 'Midnight')).toBeUndefined();

        await eventSource.emit(event_types.SETTINGS_LOADED);

        const regName = findRegisteredPresetName('A', 'Midnight');
        expect(regName).toBe('Midnight - 战斗版');
        expect(readPresetMarker(openai_settings[openai_setting_names[regName!]])?.kind).toBe('profile');
    });

    it('注册/重写投影时 POST /api/presets/save（文件型落盘，reload 不丢）', async () => {
        initPresetRegistration();
        addPreset('Midnight', samplePreset());
        await eventSource.emit(event_types.SETTINGS_LOADED);

        const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
        const saveCalls = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).endsWith('/api/presets/save'));
        expect(saveCalls.length).toBeGreaterThan(0);
        const body = JSON.parse(saveCalls[0][1].body as string);
        expect(body.name).toBe('Midnight - 战斗版');
        expect(body.preset.extensions.preset_cards.marker).toBe('preset-cards-v4');
    });
});

describe('原生删除清理（C2）', () => {
    it('PRESET_DELETED 时注销投影并 POST /api/presets/delete（zombie 防残留）', async () => {
        initPresetRegistration();
        addPreset('Midnight', samplePreset());
        await eventSource.emit(event_types.SETTINGS_LOADED);
        expect(findRegisteredPresetName('A', 'Midnight')).toBe('Midnight - 战斗版');

        // ST 原生删除(openai.js onDeletePresetClick)：只删 option + openai_setting_names,不动数组
        delete openai_setting_names['Midnight'];
        await eventSource.emit(event_types.PRESET_DELETED, { apiId: 'openai', name: 'Midnight' });
        await new Promise((r) => setImmediate(r));

        expect(findRegisteredPresetName('A', 'Midnight')).toBeUndefined();
        expect(openai_setting_names['Midnight - 战斗版']).toBeUndefined();
        const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
        const deleteCalls = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).endsWith('/api/presets/delete'));
        expect(deleteCalls.some((c: any[]) => JSON.parse(c[1].body as string).name === 'Midnight - 战斗版')).toBe(true);
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

    it('BEFORE hook removes stale keys that are absent from the fresh projection', async () => {
        const preset = samplePreset();
        preset.obsolete_flag = 'stale';
        const idx = addPreset('Midnight', preset);
        syncPresetRegistrations('Midnight', idx);
        const regName = 'Midnight - 战斗版';
        const regIdx = openai_setting_names[regName];
        initRegisteredPresetActivation();

        delete (openai_settings[idx] as Record<string, any>).obsolete_flag;
        const incoming = structuredClone(openai_settings[regIdx]);
        await eventSource.emit(event_types.OAI_PRESET_CHANGED_BEFORE, {
            preset: incoming,
            presetName: regName,
            settings: {},
        });

        expect(incoming).not.toHaveProperty('obsolete_flag');
    });

    it('PRESET_CHANGED on the parent preset keeps activeProfile (field-level load path, C4)', async () => {
        const idx = addPreset('Midnight', samplePreset());
        syncPresetRegistrations('Midnight', idx);
        initRegisteredPresetObserver();
        // 字段级加载(applyProfileToPresetByName)后：激活在父预设,activeProfile 指向该 profile
        setActiveProfile({ presetName: 'Midnight', profileId: 'A' });

        await eventSource.emit(event_types.PRESET_CHANGED, { apiId: 'openai', name: 'Midnight' });
        expect(getActiveProfile()).toEqual({ presetName: 'Midnight', profileId: 'A' }); // 保留

        // 切到无关预设 → 清空
        addPreset('Plain', { name: 'Plain', extensions: {} });
        await eventSource.emit(event_types.PRESET_CHANGED, { apiId: 'openai', name: 'Plain' });
        expect(getActiveProfile()).toBeUndefined();
    });
});
