import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { saveMeta, saveMetaMerged } from '../src/meta.js';
import { addPreset, openai_setting_names, openai_settings } from './mocks/openai.js';

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true } as Response)));
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('saveMeta 持久化统一机制', () => {
    it('合并窗口内多次保存合并为一次，末次 meta 胜出', async () => {
        vi.useFakeTimers();
        addPreset('P', { prompts: [], extensions: {} });
        const idx = openai_settings.length - 1;
        const p1 = saveMeta('P', idx, { description: 'a', models: [], profiles: [], bgImage: '' });
        const p2 = saveMeta('P', idx, { description: 'b', models: [], profiles: [], bgImage: '' });
        await vi.advanceTimersByTimeAsync(400);
        await Promise.all([p1, p2]);
        const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
        expect(body.preset.extensions.preset_cards.description).toBe('b');
    });

    it('saveMetaMerged 与 saveMeta 共享同一合并窗口', async () => {
        vi.useFakeTimers();
        addPreset('Q', { prompts: [], extensions: {} });
        const idx = openai_settings.length - 1;
        const p1 = saveMeta('Q', idx, { description: 'a', models: [], profiles: [], bgImage: '' });
        const p2 = saveMetaMerged('Q', idx, { description: 'c', models: [], profiles: [], bgImage: '' });
        await vi.advanceTimersByTimeAsync(400);
        await Promise.all([p1, p2]);
        const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
        expect(body.preset.extensions.preset_cards.description).toBe('c');
    });

    it('窗口外的第二次保存独立落盘', async () => {
        vi.useFakeTimers();
        addPreset('R', { prompts: [], extensions: {} });
        const idx = openai_settings.length - 1;
        const p1 = saveMeta('R', idx, { description: 'a', models: [], profiles: [], bgImage: '' });
        await vi.advanceTimersByTimeAsync(400);
        await p1;
        const p2 = saveMeta('R', idx, { description: 'b', models: [], profiles: [], bgImage: '' });
        await vi.advanceTimersByTimeAsync(400);
        await p2;
        const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const last = JSON.parse(fetchMock.mock.calls[1][1].body as string);
        expect(last.preset.extensions.preset_cards.description).toBe('b');
    });

    it('保存失败 reject 给调用方且不阻塞后续保存', async () => {
        vi.useFakeTimers();
        addPreset('S', { prompts: [], extensions: {} });
        const idx = openai_settings.length - 1;
        const fetchMock = vi.fn(async () => ({ ok: false } as Response));
        vi.stubGlobal('fetch', fetchMock);
        const p1 = saveMeta('S', idx, { description: 'fail', models: [], profiles: [], bgImage: '' });
        const rejection = expect(p1).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(400);
        await rejection;
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true } as Response)));
        const p2 = saveMeta('S', idx, { description: 'ok', models: [], profiles: [], bgImage: '' });
        await vi.advanceTimersByTimeAsync(400);
        await expect(p2).resolves.toBeUndefined();
    });

    it('预设删除后放弃延迟落盘（避免用旧 body 重建已删预设）', async () => {
        vi.useFakeTimers();
        const idx = addPreset('T', { prompts: [], extensions: {} });
        const p = saveMeta('T', idx, { description: 'x', models: [], profiles: [], bgImage: '' });
        // 合并窗口内删除预设（删除路径只移除 openai_setting_names 条目）
        delete openai_setting_names['T'];
        await vi.advanceTimersByTimeAsync(400);
        await p;
        const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
