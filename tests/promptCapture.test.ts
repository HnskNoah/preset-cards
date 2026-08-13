import { describe, it, expect } from 'vitest';
import { capturePromptFields, filterFields, promptFieldsEqual, captureExtra, captureModel } from '../src/promptCapture.js';

describe('promptCapture', () => {
    it('captures whitelist fields from a prompt', () => {
        const fields = capturePromptFields({ content: 'hello', role: 'system', injection_order: 5, foo: 'bar' });
        expect(fields).toEqual({ content: 'hello', role: 'system' });
    });

    it('filters fields to whitelist only', () => {
        expect(filterFields({ content: 'x', injection_position: 2, injection_depth: 4 })).toEqual({ content: 'x', injection_position: 2, injection_depth: 4 });
        expect(filterFields({ injection_order: 1 })).toEqual({});
    });

    it('compares fields equality', () => {
        expect(promptFieldsEqual({ content: 'a' }, { content: 'a' })).toBe(true);
        expect(promptFieldsEqual({ content: 'a' }, { content: 'b' })).toBe(false);
        expect(promptFieldsEqual({}, {})).toBe(true);
    });

    it('captures extra keys excluding sampling, connections, prompts, extensions', () => {
        const extra = captureExtra({ impersonation_prompt: 'x', bias_preset_selected: 'y', temperature: 0.8, prompts: [], extensions: {}, custom_url: 'http://x', name: 'test' } as any);
        expect(extra).toEqual({ impersonation_prompt: 'x', bias_preset_selected: 'y' });
    });

    it('captures model from preset source + model key', () => {
        const model = captureModel({ chat_completion_source: 'openai', openai_model: 'gpt-4o' } as any);
        expect(model).toEqual({ source: 'openai', name: 'gpt-4o' });
    });

    it('returns null for unknown source', () => {
        expect(captureModel({ chat_completion_source: 'unknown', unknown_model: 'x' } as any)).toBeNull();
    });
});