import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveProfile, setActiveProfile } from '../src/activeProfile.js';
import { applyProfileToPresetByName } from '../src/presetCardsState.js';
import { addPreset, oai_settings, openai_settings } from './mocks/openai.js';

beforeEach(() => {
    vi.useFakeTimers();
    setActiveProfile(undefined);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('applyProfileToPresetByName persistence failure', () => {
    it('restores the preset and active profile when saving fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false } as Response)));
        const preset = {
            prompts: [{ identifier: 'p1', content: 'original' }],
            prompt_order: [{ name: 'main', order: [{ identifier: 'p1', enabled: true }] }],
            extensions: {
                preset_cards: {
                    profiles: [{
                        formatVersion: 3,
                        kind: 'prompt_base',
                        id: 'B',
                        name: 'Base',
                        prompts: [{ identifier: 'p1', mounted: true, enabled: true, fields: { content: 'changed' } }],
                    }],
                    defaultSnapshot: [{ identifier: 'p1', mounted: true, enabled: true, originalFields: { content: 'original' } }],
                    defaultSnapshotLocked: true,
                },
            },
        };
        addPreset('Parent', preset);

        const pending = applyProfileToPresetByName('Parent', 'B');
        await vi.advanceTimersByTimeAsync(301);

        expect(await pending).toBe(false);
        expect((openai_settings[0] as Record<string, any>).prompts[0].content).toBe('original');
        expect(getActiveProfile()).toBeUndefined();
    });

    it('restores runtime oai_settings.extensions when the target IS the active preset', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false } as Response)));
        const preset = {
            prompts: [{ identifier: 'p1', content: 'original' }],
            prompt_order: [{ name: 'main', order: [{ identifier: 'p1', enabled: true }] }],
            extensions: {
                preset_cards: {
                    profiles: [{
                        formatVersion: 3,
                        kind: 'prompt_base',
                        id: 'B',
                        name: 'Base',
                        prompts: [{ identifier: 'p1', mounted: true, enabled: true, fields: { content: 'changed' } }],
                    }],
                    defaultSnapshot: [{ identifier: 'p1', mounted: true, enabled: true, originalFields: { content: 'original' } }],
                    defaultSnapshotLocked: true,
                },
            },
        };
        addPreset('Active', preset);
        // 预置运行时镜像为旧值（模拟上次成功保存的状态）
        const oldRuntimeMeta = { profiles: [{ marker: 'old' }] };
        if (!oai_settings.extensions) oai_settings.extensions = {} as Record<string, any>;
        (oai_settings.extensions as Record<string, any>).preset_cards = oldRuntimeMeta;

        const pending = applyProfileToPresetByName('Active', 'B');
        await vi.advanceTimersByTimeAsync(301);

        expect(await pending).toBe(false);
        expect((openai_settings[0] as Record<string, any>).prompts[0].content).toBe('original');
        expect(getActiveProfile()).toBeUndefined();
        // 副本先行：fetch 失败时 extensions 从未被写入——运行时镜像保持旧引用，
        // 预设记录也保持原 meta（不会出现「fetch 前已写入新值、靠 catch 还原」的中间态）
        expect((oai_settings.extensions as Record<string, any>).preset_cards).toBe(oldRuntimeMeta);
        const recordMeta = ((openai_settings[0] as Record<string, any>).extensions as Record<string, any>).preset_cards;
        expect(recordMeta).not.toBe(oldRuntimeMeta);
        expect((recordMeta as Record<string, any>).profiles[0].name).toBe('Base'); // 原 meta 完好
    });
});
