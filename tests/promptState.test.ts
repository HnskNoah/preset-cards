import { describe, it, expect } from 'vitest';
import {
    snapshotPromptState,
    applyPromptDelta,
    diffPromptState,
    arrangePromptEntries,
    replacementPromptOrder,
    entriesFromDefaultSnapshot,
    isNeverCaptureIdentifier,
    promptOrderTarget,
} from '../src/promptState.js';

const base = (identifier: string, mounted = true, enabled = true): any => ({ identifier, mounted, enabled });

describe('promptState', () => {
    it('captures mounted entries and collects unused ids', () => {
        const prompts = [
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: false },
            { identifier: 'c' },
        ];
        const order = [
            { identifier: 'b', enabled: true },
            { identifier: 'a', enabled: true },
        ];
        const { entries, unusedIds } = snapshotPromptState(prompts, order);
        expect(entries.map((e) => e.identifier)).toEqual(['b', 'a']);
        expect(entries.find((e) => e.identifier === 'b')?.enabled).toBe(true);
        expect(entries.find((e) => e.identifier === 'a')?.lastActiveIndex).toBe(1);
        expect(unusedIds).toEqual(['c']);
    });

    it('skips never-capture identifiers (SPresetSettings)', () => {
        expect(isNeverCaptureIdentifier('SPresetSettings')).toBe(true);
        const { entries, unusedIds } = snapshotPromptState(
            [{ identifier: 'SPresetSettings' }, { identifier: 'a' }],
            [{ identifier: 'a' }],
        );
        expect(entries).toHaveLength(1);
        expect(unusedIds).toEqual([]);
    });

    it('applies delta changes on top of parent entries', () => {
        const parent = [base('a'), base('b'), base('c')];
        const result = applyPromptDelta(parent, [
            { identifier: 'b', enabled: false },
            { identifier: 'd', mounted: true, enabled: true },
        ], ['a', 'd', 'b']);
        const byId = new Map(result.map((e) => [e.identifier, e]));
        expect(byId.get('b')?.enabled).toBe(false);
        expect(byId.get('d')?.mounted).toBe(true);
        expect(result.map((e) => e.identifier)).toEqual(['a', 'd', 'b', 'c']);
    });

    it('unmounts parent entries via mounted:false', () => {
        const parent = [base('a'), base('b')];
        const result = applyPromptDelta(parent, [{ identifier: 'b', mounted: false }]);
        const byId = new Map(result.map((e) => [e.identifier, e]));
        expect(byId.get('b')?.mounted).toBe(false);
        expect(result.filter((e) => e.mounted).map((e) => e.identifier)).toEqual(['a']);
    });

    it('computes diff including order changes and unmounts', () => {
        const parent = [base('a'), base('b'), base('c')];
        const child = [base('c'), base('a'), { ...base('b'), mounted: false }];
        const { changes, order } = diffPromptState(child, parent, ['b']);
        expect(order).toEqual(['c', 'a']);
        expect(changes).toContainEqual({ identifier: 'b', mounted: false });
        expect(changes.some((c) => c.identifier === 'a')).toBe(false);
    });

    it('arranges entries by requested order with unused tail', () => {
        const entries = [base('a'), base('b'), { ...base('c'), mounted: false }];
        const arranged = arrangePromptEntries(entries, ['b', 'a']);
        expect(arranged.map((e) => e.identifier)).toEqual(['b', 'a', 'c']);
    });

    it('replacement order only includes mounted valid identifiers', () => {
        const entries = [base('a'), { ...base('b'), mounted: false }, base('c')];
        const out = replacementPromptOrder(entries, new Set(['a', 'b', 'c', 'd']));
        expect(out).toEqual([{ identifier: 'a', enabled: true }, { identifier: 'c', enabled: true }]);
    });

    it('restores entries from default snapshot with legacy boolean inference', () => {
        const out = entriesFromDefaultSnapshot([
            { identifier: 'a', mounted: true, enabled: true, originalFields: { content: 'x' } },
            { identifier: 'b', enabled: false },
        ]);
        expect(out[0].fields).toEqual({ content: 'x' });
        expect(out[1].mounted).toBe(true);
        expect(out[1].enabled).toBe(false);
    });

    it('resolves prompt order target strategy', () => {
        expect(promptOrderTarget('global')).toBe(100001);
        expect(promptOrderTarget('character')).toBe(100001);
        expect(promptOrderTarget('character', 42)).toBe(42);
    });
});
