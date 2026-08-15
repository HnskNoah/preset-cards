// TEMP verify harness (verifier's own) — delete after run.
// Re-verify claim 17 against CURRENT meta.ts (concurrent fix moved onMetaPersisted
// into saveMeta's success path): saveMetaMerged should NOW fire onMetaPersisted.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetOpenaiMock, addPreset, openai_settings } from '../mocks/openai.js';
import { persistMetaTransaction, saveMetaMerged, onMetaPersisted, readMeta } from '../../src/meta.js';

function parentPreset(): Record<string, any> {
    return {
        name: 'Midnight',
        prompts: [],
        extensions: { preset_cards: { description: 'd', models: [], bgImage: '', profiles: [] } },
    };
}

beforeEach(() => {
    resetOpenaiMock();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true } as Response)));
    addPreset('Midnight', parentPreset());
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('claim17 current-state: saveMetaMerged now triggers onMetaPersisted', () => {
    it('persistMetaTransaction fires onMetaPersisted (unchanged)', async () => {
        const idx = 0;
        const meta = readMeta(openai_settings[idx] as any);
        const seen: [string, number][] = [];
        onMetaPersisted((n, i) => seen.push([n, i]));
        const ok = await persistMetaTransaction(meta, (m) => ({ ...m, description: 'x' }), 'Midnight', idx);
        expect(ok).toBe(true);
        expect(seen).toEqual([['Midnight', 0]]);
    });

    it('saveMetaMerged (editor 更新 path) NOW fires onMetaPersisted → sync runs', async () => {
        const idx = 0;
        const meta = readMeta(openai_settings[idx] as any);
        const seen: [string, number][] = [];
        onMetaPersisted((n, i) => seen.push([n, i]));
        await saveMetaMerged('Midnight', idx, { ...meta, description: 'y' });
        expect(seen).toEqual([['Midnight', 0]]); // FIXED: editor commit now syncs registrations
    });
});
