import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveProfile, setActiveProfile } from '../src/activeProfile.js';
import { applyProfileToPresetByName } from '../src/presetCardsState.js';
import { addPreset, openai_settings } from './mocks/openai.js';

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
});
