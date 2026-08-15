import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetOpenaiMock, addPreset, openai_settings, openai_setting_names, oai_settings } from './mocks/openai.js';
import { eventSource, event_types } from './mocks/events.js';
import { captureIfRegistered, initPresetCapture } from '../src/presetCapture.js';
import { initPresetRegistration, syncPresetRegistrations } from '../src/presetRegistration.js';
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
