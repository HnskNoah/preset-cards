import { describe, it, expect } from 'vitest';
import {
    isPromptFieldsData,
    isV3BaseProfileData,
    isV3DeltaProfileData,
    assertV3ImportPayload,
    LegacyProfileFormatError,
} from '../src/profileSchema.js';

const base = {
    formatVersion: 3,
    kind: 'prompt_base',
    id: 'b1',
    name: 'Base',
    prompts: [{ identifier: 'a', mounted: true, enabled: true, lastActiveIndex: 0 }],
};

const delta = {
    formatVersion: 3,
    kind: 'prompt_delta',
    id: 'd1',
    name: 'Delta',
    baseId: 'b1',
    changes: [{ identifier: 'a', mounted: true, enabled: false }],
};

describe('profileSchema', () => {
    it('accepts valid v3 base and delta', () => {
        expect(isV3BaseProfileData(base)).toBe(true);
        expect(isV3DeltaProfileData(delta)).toBe(true);
    });

    it('rejects wrong formatVersion / kind / missing required fields', () => {
        expect(isV3BaseProfileData({ ...base, formatVersion: 2 })).toBe(false);
        expect(isV3BaseProfileData({ ...base, kind: 'prompt_delta' })).toBe(false);
        expect(isV3DeltaProfileData({ ...delta, baseId: undefined })).toBe(false);
        expect(isV3BaseProfileData({ ...base, prompts: 'x' })).toBe(false);
    });

    it('validates fields whitelist and scalar types', () => {
        expect(isPromptFieldsData({ content: 'x', injection_position: 2, injection_depth: 4 })).toBe(true);
        expect(isPromptFieldsData({ content: 1 })).toBe(false);
        expect(isPromptFieldsData({ injection_position: '2' })).toBe(false);
        expect(isPromptFieldsData({ injection_order: 1 })).toBe(false);
        expect(isPromptFieldsData(null)).toBe(false);
    });

    it('accepts unusedIds and delta order arrays', () => {
        expect(isV3BaseProfileData({ ...base, unusedIds: ['u'] })).toBe(true);
        expect(isV3DeltaProfileData({ ...delta, order: ['a'] })).toBe(true);
        expect(isV3DeltaProfileData({ ...delta, order: [1] })).toBe(false);
    });

    it('accepts optional model field as extra metadata', () => {
        expect(isV3BaseProfileData({ ...base, model: { source: 'openai', name: 'gpt-4o' } })).toBe(true);
        expect(isV3DeltaProfileData({ ...delta, model: { source: 'claude', name: 'claude-3' } })).toBe(true);
    });

    it('asserts tree payload and rejects non-v3 formats', () => {
        assertV3ImportPayload({ kind: 'prompt_tree', formatVersion: 3, profiles: [base, delta] });
        expect(() => assertV3ImportPayload({ ...base, formatVersion: 2 })).toThrow(LegacyProfileFormatError);
        expect(() => assertV3ImportPayload({ kind: 'prompt_tree', formatVersion: 3, profiles: [base, { ...delta, formatVersion: 2 }] })).toThrow(LegacyProfileFormatError);
    });

    it('accepts embedded delta parent shape { name, prompts }', () => {
        assertV3ImportPayload({ ...delta, base: { name: 'Imported Parent', prompts: base.prompts } });
        expect(() => assertV3ImportPayload({ ...delta, base: { prompts: 'bad' } })).toThrow(LegacyProfileFormatError);
    });
});
