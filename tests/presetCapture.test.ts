import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetOpenaiMock, addPreset, openai_settings, openai_setting_names, oai_settings } from './mocks/openai.js';
import { eventSource, event_types } from './mocks/events.js';
import { captureIfRegistered, initPresetCapture } from '../src/presetCapture.js';
import { findRegisteredPresetName, initPresetRegistration, syncPresetRegistrations } from '../src/presetRegistration.js';
import { readMeta } from '../src/meta.js';
import { readPresetMarker } from '../src/core/storage/marker.js';

// 捕获测试需要 onMetaPersisted → sync 刷新注册记录（init 的接线在测试里显式注册一次）
initPresetRegistration();

/** 父预设：base profile + 两个 prompt（p1 将被改、pDeleted 将被删、p3 将被新增）。 */
function parentFixture(): Record<string, any> {
    return {
        name: 'Midnight',
        prompts: [
            { identifier: 'p1', content: 'v1', role: 'system', system_prompt: false, marker: false },
            { identifier: 'pDeleted', content: 'gone', role: 'system', system_prompt: false, marker: false },
        ],
        prompt_order: [{ name: 'main', order: [
            { identifier: 'p1', enabled: true },
            { identifier: 'pDeleted', enabled: true },
        ] }],
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
                    prompts: [
                        { identifier: 'p1', mounted: true, enabled: true, fields: { content: 'v1' } },
                        { identifier: 'pDeleted', mounted: true, enabled: true },
                    ],
                }],
                defaultSnapshotLocked: true,
                defaultSnapshot: [
                    { identifier: 'p1', mounted: true, enabled: true, originalFields: { content: 'v1' } },
                    { identifier: 'pDeleted', mounted: true, enabled: true, originalFields: { content: 'gone' } },
                ],
            },
        },
    };
}

/** 模拟用户原生编辑后的运行时：改 p1、删 pDeleted、新增 p3、重排。 */
function applyUserEdit(): void {
    oai_settings.preset_settings_openai = 'Midnight - 战斗版';
    oai_settings.prompts = [
        { identifier: 'p1', content: 'v2', role: 'system', system_prompt: false, marker: false },
        { identifier: 'p3', content: 'new', role: 'system', system_prompt: false, marker: false },
    ];
    oai_settings.prompt_order = [{ name: 'main', order: [
        { identifier: 'p1', enabled: true },
        { identifier: 'p3', enabled: true },
    ] }];
}

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true } as Response)));
    // 对账后 NEW-2 重应用会走 fastApplyPreset：DOM 写入兜底
    vi.stubGlobal('document', { querySelector: () => null });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('captureIfRegistered', () => {
    it('gate: skips when the active preset is not a registered profile', async () => {
        addPreset('Plain', { name: 'Plain', extensions: {} });
        oai_settings.preset_settings_openai = 'Plain';
        expect(await captureIfRegistered()).toBe(false);
    });

    it('skips when the registered record has no prompts baseline (C6: no flood of added)', async () => {
        const emptyParent = {
            name: 'Midnight',
            extensions: {
                preset_cards: {
                    description: '',
                    models: [],
                    bgImage: '',
                    profiles: [{ formatVersion: 3, kind: 'prompt_base', id: 'A', name: '战斗版', prompts: [] }],
                },
            },
        };
        const parentIdx = addPreset('Midnight', emptyParent);
        syncPresetRegistrations('Midnight', parentIdx);
        // 激活投影(无 prompts)+ ST 重建了默认 prompts
        oai_settings.preset_settings_openai = 'Midnight - 战斗版';
        oai_settings.prompts = [{ identifier: 'p1', content: 'default' }];
        oai_settings.prompt_order = [{ name: 'main', order: [{ identifier: 'p1', enabled: true }] }];

        expect(await captureIfRegistered()).toBe(false); // 无基线 → 不把全部默认 prompt 当 added
        // 父池未被灌入
        const parent = openai_settings[parentIdx] as Record<string, any>;
        expect(Array.isArray(parent.prompts) ? parent.prompts : []).toEqual([]);
    });

    it('no-op when runtime matches the registered record', async () => {
        const parentIdx = addPreset('Midnight', parentFixture());
        syncPresetRegistrations('Midnight', parentIdx);
        // 运行时 = 注册记录（激活后未编辑）：整记录克隆，含采样等顶层键
        const regIdx = openai_setting_names['Midnight - 战斗版'];
        const record = openai_settings[regIdx];
        Object.assign(oai_settings, structuredClone(record));
        oai_settings.preset_settings_openai = 'Midnight - 战斗版';
        expect(await captureIfRegistered()).toBe(false);
    });

    it('no-op when extension drift equals the stored extProfile (net-zero, no persist)', async () => {
        const parent = parentFixture();
        parent.extensions.regex_scripts = [{ id: 'r1', findRegex: 'a' }];
        parent.extensions.preset_cards.profiles[0].extProfile = { extToggles: { 'regex_scripts.r1.disabled': true } };
        const parentIdx = addPreset('Midnight', parent);
        syncPresetRegistrations('Midnight', parentIdx);
        const regIdx = openai_setting_names['Midnight - 战斗版'];
        Object.assign(oai_settings, structuredClone(openai_settings[regIdx]));
        oai_settings.preset_settings_openai = 'Midnight - 战斗版';
        // 运行时扩展 = 父状态 + 已存 extProfile 描述的差异（等价重放，无新漂移）
        (oai_settings.extensions as Record<string, any>).regex_scripts = [{ id: 'r1', findRegex: 'a', disabled: true }];
        const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
        const callsBefore = fetchMock.mock.calls.length;
        expect(await captureIfRegistered()).toBe(false);
        expect(fetchMock.mock.calls.length).toBe(callsBefore); // 净零：零落盘（旧实现每次保存事件都全量 POST）
    });

    it('captures drift back into the profile, restores pool, adds new prompt, refreshes record', async () => {
        const parentIdx = addPreset('Midnight', parentFixture());
        syncPresetRegistrations('Midnight', parentIdx);
        applyUserEdit();

        expect(await captureIfRegistered()).toBe(true);

        const parent = openai_settings[parentIdx] as Record<string, any>;
        const meta = readMeta(parent as any);
        const profile = meta.profiles[0] as any;

        // 值字段与挂载态捕获回 profile
        expect(profile.prompts.find((e: any) => e.identifier === 'p1').fields).toEqual({ content: 'v2' });
        expect(profile.prompts.find((e: any) => e.identifier === 'pDeleted').mounted).toBe(false);
        expect(profile.prompts.find((e: any) => e.identifier === 'p3')).toMatchObject({ mounted: true, enabled: true });
        expect(profile.unusedIds).toContain('pDeleted');
        // base 顺序 = 运行时挂载序
        expect(profile.prompts.filter((e: any) => e.mounted).map((e: any) => e.identifier)).toEqual(['p1', 'p3']);

        // 材料恢复（删除的 pDeleted）+ 新增 p3 定义入父池（dormant）
        const poolIds = (parent.prompts as any[]).map((p: any) => p.identifier);
        expect(poolIds).toContain('pDeleted');
        expect(poolIds).toContain('p3');
        expect((parent.prompts as any[]).find((p: any) => p.identifier === 'p3').content).toBe('new');

        // 注册记录已刷新（onMetaPersisted → sync）
        const record = openai_settings[openai_setting_names['Midnight - 战斗版']];
        expect(record.prompts.find((p: any) => p.identifier === 'p1').content).toBe('v2');
        expect(readPresetMarker(record)?.kind).toBe('profile');
    });
});

describe('initPresetCapture', () => {
    it('captures on SETTINGS_UPDATED event', async () => {
        const parentIdx = addPreset('Midnight', parentFixture());
        syncPresetRegistrations('Midnight', parentIdx);
        initPresetCapture();
        applyUserEdit();

        await eventSource.emit(event_types.SETTINGS_UPDATED);

        // 监听器为 fire-and-forget：轮询等待后台捕获完成（20ms × 最多 5s）
        const parent = openai_settings[parentIdx] as Record<string, any>;
        for (let i = 0; i < 250; i++) {
            const profile = readMeta(parent as any).profiles[0] as any;
            if (profile.prompts.find((e: any) => e.identifier === 'p1')?.fields?.content === 'v2') break;
            await new Promise((r) => setTimeout(r, 20));
        }
        const profile = readMeta(parent as any).profiles[0] as any;
        expect(profile.prompts.find((e: any) => e.identifier === 'p1').fields).toEqual({ content: 'v2' });
    });
});

describe('捕获周期：持久化窗口内并发 SETTINGS_UPDATED 不丢编辑', () => {
    it('被挡事件重跑捕获，重应用不回滚窗口内编辑', async () => {
        const parentIdx = addPreset('Midnight', parentFixture());
        syncPresetRegistrations('Midnight', parentIdx);
        const regIdx = openai_setting_names['Midnight - 战斗版'];
        Object.assign(oai_settings, structuredClone(openai_settings[regIdx]));
        oai_settings.preset_settings_openai = 'Midnight - 战斗版';
        initPresetCapture();

        // 编辑 A：p1 content → v2，触发捕获进入持久化窗口（300ms 合并 + POST）
        oai_settings.prompts = (oai_settings.prompts as any[]).map((p: any) =>
            p.identifier === 'p1' ? { ...p, content: 'v2' } : p);
        void eventSource.emit(event_types.SETTINGS_UPDATED);
        await new Promise((r) => setTimeout(r, 5)); // 捕获已读取运行时（仅含 A）并进入 await

        // 窗口内编辑 B：p1 关闭（改在目标策略 order 列表上——drift 按 character_id 列表比较）。
        // 旧实现：事件被防重入门丢弃 → 捕获 A 落盘后 refresh 用旧时点记录重应用 → B 被静默抹掉。
        // 新实现：记待重跑，捕获链落定后应用含 B 的最新记录。
        const targetList = (oai_settings.prompt_order as any[]).find((l: any) => String(l.character_id) === '100001')
            ?? (oai_settings.prompt_order as any[])[0];
        targetList.order = (targetList.order as any[]).map((e: any) =>
            e.identifier === 'p1' ? { ...e, enabled: false } : e);
        void eventSource.emit(event_types.SETTINGS_UPDATED);

        const parent = openai_settings[parentIdx] as Record<string, any>;
        for (let i = 0; i < 250; i++) {
            const profile = readMeta(parent as any).profiles[0] as any;
            if (profile.prompts.find((e: any) => e.identifier === 'p1')?.fields?.content === 'v2'
                && profile.prompts.find((e: any) => e.identifier === 'p1')?.enabled === false) break;
            await new Promise((r) => setTimeout(r, 20));
        }
        const profile = readMeta(parent as any).profiles[0] as any;
        // 两次编辑都被捕获进 profile
        expect(profile.prompts.find((e: any) => e.identifier === 'p1').fields).toEqual({ content: 'v2' });
        expect(profile.prompts.find((e: any) => e.identifier === 'p1').enabled).toBe(false);

        // 重应用后运行时保留两次编辑（未被旧时点记录回滚）
        for (let i = 0; i < 250; i++) {
            const list = (oai_settings.prompt_order as any[]).find((l: any) => String(l.character_id) === '100001')
                ?? (oai_settings.prompt_order as any[])[0];
            const orderEntry = (list.order as any[]).find((e: any) => e.identifier === 'p1');
            const prompt = (oai_settings.prompts as any[]).find((p: any) => p.identifier === 'p1');
            if (orderEntry?.enabled === false && prompt?.content === 'v2') break;
            await new Promise((r) => setTimeout(r, 20));
        }
        expect((oai_settings.prompts as any[]).find((p: any) => p.identifier === 'p1')?.content).toBe('v2');
        const finalList = (oai_settings.prompt_order as any[]).find((l: any) => String(l.character_id) === '100001')
            ?? (oai_settings.prompt_order as any[])[0];
        expect((finalList.order as any[]).find((e: any) => e.identifier === 'p1')?.enabled).toBe(false);
    }, 20000);
});

describe('NEW-1：ST 预设键 ↔ 设置键映射', () => {
    it('maps preset-key to settings-key in top-level compare (no extra flood)', async () => {
        // 模拟真实 ST 映射：预设键 temperature ↔ 设置键 temp_openai（settingsToUpdate）
        const { settingsToUpdate } = await import('./mocks/openai.js');
        const orig = settingsToUpdate['temperature'];
        settingsToUpdate['temperature'] = ['#temp_openai', 'temp_openai', false, false];
        try {
            const parentIdx = addPreset('Midnight', parentFixture()); // temperature: 0.7
            syncPresetRegistrations('Midnight', parentIdx);

            // 激活投影：运行时 = 注册记录克隆（设置键空间 temp_openai），再改一个 prompt 内容触发捕获
            const regIdx = openai_setting_names['Midnight - 战斗版'];
            const record = openai_settings[regIdx];
            Object.assign(oai_settings, structuredClone(record));
            oai_settings.preset_settings_openai = 'Midnight - 战斗版';
            oai_settings.temp_openai = 0.7;
            oai_settings.prompts = (oai_settings.prompts as any[]).map((p: any) =>
                p.identifier === 'p1' ? { ...p, content: 'v2' } : p,
            );

            await captureIfRegistered();

            const parent = openai_settings[parentIdx] as Record<string, any>;
            const profile = readMeta(parent as any).profiles[0] as any;
            // 键空间映射下温度一致 → 无顶层漂移 → extra 不得被灌入设置键名/采样键
            expect(profile.extra ?? {}).not.toHaveProperty('temp_openai');
            expect(Object.keys(profile.extra ?? {})).not.toContain('temperature');
            // prompt 漂移仍正常捕获
            expect(profile.prompts.find((e: any) => e.identifier === 'p1').fields).toEqual({ content: 'v2' });
        } finally {
            settingsToUpdate['temperature'] = orig;
        }
    });
});

function topLevelCaptureFixture(): Record<string, any> {
    return {
        prompts: [{ identifier: 'p1', content: 'base', role: 'system', system_prompt: false, marker: false }],
        prompt_order: [{ name: 'main', order: [{ identifier: 'p1', enabled: true }] }],
        temperature: 0.7,
        custom_prompt_post_processing: 'base',
        chat_completion_source: 'openai',
        openai_model: 'gpt-default',
        extensions: {
            preset_cards: {
                description: '',
                models: [],
                bgImage: '',
                defaultSnapshotLocked: true,
                defaultSnapshot: [{ identifier: 'p1', mounted: true, enabled: true, originalFields: { content: 'base' } }],
                defaultSampling: { temperature: 0.7 },
                defaultExtra: { custom_prompt_post_processing: 'base' },
                defaultModel: { source: 'openai', name: 'gpt-default' },
                profiles: [
                    {
                        formatVersion: 3,
                        kind: 'prompt_base',
                        id: 'B',
                        name: 'Base',
                        prompts: [{ identifier: 'p1', mounted: true, enabled: true }],
                    },
                    {
                        formatVersion: 3,
                        kind: 'prompt_delta',
                        id: 'D',
                        name: 'Delta',
                        baseId: 'B',
                        changes: [],
                        sampling: { temperature: 1 },
                        extra: { custom_prompt_post_processing: 'delta' },
                        model: { source: 'openai', name: 'gpt-old' },
                    },
                ],
            },
        },
    };
}

function activateRegisteredDelta(parentIndex: number): void {
    syncPresetRegistrations('Parent', parentIndex);
    const registeredName = findRegisteredPresetName('D', 'Parent') as string;
    const registered = openai_settings[openai_setting_names[registeredName]] as Record<string, any>;
    Object.assign(oai_settings, structuredClone(registered), { preset_settings_openai: registeredName });
}

describe('registered profile top-level override capture', () => {
    it('removes sampling and extra overrides when runtime returns to the inherited baseline', async () => {
        const parentIndex = addPreset('Parent', topLevelCaptureFixture());
        activateRegisteredDelta(parentIndex);
        oai_settings.temperature = 0.7;
        oai_settings.custom_prompt_post_processing = 'base';

        expect(await captureIfRegistered()).toBe(true);

        const delta = (openai_settings[parentIndex] as Record<string, any>)
            .extensions.preset_cards.profiles.find((profile: any) => profile.id === 'D');
        expect(delta).not.toHaveProperty('sampling');
        expect(delta).not.toHaveProperty('extra');
    });

    it('captures a model-only change and removes the override when it matches the default model', async () => {
        const parentIndex = addPreset('Parent', topLevelCaptureFixture());
        activateRegisteredDelta(parentIndex);
        oai_settings.openai_model = 'gpt-default';

        expect(await captureIfRegistered()).toBe(true);

        const delta = (openai_settings[parentIndex] as Record<string, any>)
            .extensions.preset_cards.profiles.find((profile: any) => profile.id === 'D');
        expect(delta).not.toHaveProperty('model');
    });
});
