import { describe, it, expect } from 'vitest';
import { migrateFile } from '../tools/migrate-to-v3.js';

describe('migrate-to-v3', () => {
    it('migrates v2 base: adds mounted/lastActiveIndex', () => {
        const out = migrateFile({
            formatVersion: 2,
            kind: 'prompt_base',
            id: 'b1',
            name: 'B',
            prompts: [
                { identifier: 'a', enabled: true },
                { identifier: 'b', enabled: false },
            ],
        });
        expect(out.formatVersion).toBe(3);
        expect(out.prompts[0]).toEqual({ identifier: 'a', mounted: true, enabled: true, lastActiveIndex: 0 });
        expect(out.prompts[1]).toEqual({ identifier: 'b', mounted: true, enabled: false, lastActiveIndex: 1 });
    });

    it('migrates v2 delta: preserves baseId/changes/sampling', () => {
        const out = migrateFile({
            formatVersion: 2,
            kind: 'prompt_delta',
            id: 'd1',
            name: 'D',
            baseId: 'b1',
            changes: [{ identifier: 'a', enabled: false }],
        });
        expect(out.formatVersion).toBe(3);
        expect(out.baseId).toBe('b1');
        expect(out.changes).toEqual([{ identifier: 'a', enabled: false }]);
    });

    it('migrates v1 snapshot to prompt_tree', () => {
        const out = migrateFile({
            id: 'v1',
            name: 'Old',
            settings: {
                prompts: [{ identifier: 'a', content: 'hi', role: 'system' }],
                prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
                temperature: 0.7,
            },
        });
        expect(out.kind).toBe('prompt_tree');
        expect(out.profiles).toHaveLength(2);
        expect(out.profiles[0].archive).toBe(true);
        expect(out.profiles[1].kind).toBe('prompt_delta');
    });

    it('migrates prompt_tree with v2 entries', () => {
        const out = migrateFile({
            kind: 'prompt_tree',
            formatVersion: 3,
            profiles: [
                { formatVersion: 2, kind: 'prompt_base', id: 'b1', name: 'B', prompts: [{ identifier: 'a', enabled: true }] },
                { formatVersion: 2, kind: 'prompt_delta', id: 'd1', name: 'D', baseId: 'b1', changes: [] },
            ],
        });
        expect(out.profiles[0].formatVersion).toBe(3);
        expect(out.profiles[0].prompts[0].mounted).toBe(true);
        expect(out.profiles[1].formatVersion).toBe(3);
    });

    it('passes v3 input through unchanged', () => {
        const input = { formatVersion: 3, kind: 'prompt_delta', id: 'd', name: 'D', baseId: 'b', changes: [] };
        expect(migrateFile(input)).toBe(input);
    });

    it('throws on unrecognized format', () => {
        expect(() => migrateFile({ foo: 'bar' })).toThrow(/Unrecognized format/);
    });
});