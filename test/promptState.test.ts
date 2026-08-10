import assert from 'node:assert/strict';
import test from 'node:test';
import {
    applyPromptDelta,
    diffPromptState,
    promptOrderTarget,
    replacementPromptOrder,
    snapshotPromptState,
    type PromptProfileEntry,
} from '../src/promptState.ts';

test('snapshot preserves mounted order and appends unused prompts in definition order', () => {
    const state = snapshotPromptState(
        [{ identifier: 'a' }, { identifier: 'b', enabled: true }, { identifier: 'c', enabled: true }],
        [{ identifier: 'deleted' }, { identifier: 'c', enabled: false }, { identifier: 'a', enabled: true }],
    );
    assert.deepEqual(state, [
        { identifier: 'c', mounted: true, enabled: false, lastActiveIndex: 0 },
        { identifier: 'a', mounted: true, enabled: true, lastActiveIndex: 1 },
        { identifier: 'b', mounted: false, enabled: true },
    ]);
});

test('delta resolves mounted on, mounted off, and unused states with explicit order', () => {
    const parent: PromptProfileEntry[] = [
        { identifier: 'a', mounted: true, enabled: true, lastActiveIndex: 0 },
        { identifier: 'b', mounted: true, enabled: false, lastActiveIndex: 1 },
        { identifier: 'c', mounted: false, enabled: true, lastActiveIndex: 2 },
    ];
    const state = applyPromptDelta(parent, [
        { identifier: 'a', mounted: false, lastActiveIndex: 0 },
        { identifier: 'c', mounted: true },
    ], ['c', 'b']);
    assert.deepEqual(state.map(({ identifier, mounted, enabled }) => ({ identifier, mounted, enabled })), [
        { identifier: 'c', mounted: true, enabled: true },
        { identifier: 'b', mounted: true, enabled: false },
        { identifier: 'a', mounted: false, enabled: true },
    ]);
});

test('reactivation restores historical position and preserves enabled state', () => {
    const parent: PromptProfileEntry[] = [
        { identifier: 'a', mounted: true, enabled: true, lastActiveIndex: 0 },
        { identifier: 'b', mounted: true, enabled: true, lastActiveIndex: 1 },
        { identifier: 'c', mounted: false, enabled: true },
        { identifier: 'd', mounted: false, enabled: true, lastActiveIndex: 1 },
    ];
    const restored = applyPromptDelta(parent, [{ identifier: 'd', mounted: true }]);
    assert.deepEqual(restored.filter((entry) => entry.mounted).map((entry) => entry.identifier), ['a', 'd', 'b']);
    const appended = applyPromptDelta(parent, [{ identifier: 'c', mounted: true }]);
    assert.deepEqual(appended.filter((entry) => entry.mounted).map((entry) => [entry.identifier, entry.enabled]), [
        ['a', true], ['b', true], ['c', true],
    ]);

    const staleEnabled = applyPromptDelta([
        { identifier: 'never', mounted: false, enabled: true },
    ], [{ identifier: 'never', mounted: true }]);
    assert.deepEqual(staleEnabled.map(({ identifier, mounted, enabled, lastActiveIndex }) => ({
        identifier, mounted, enabled, lastActiveIndex,
    })), [
        { identifier: 'never', mounted: true, enabled: true, lastActiveIndex: 0 },
    ]);
});

test('delta diff records membership, enabled, fields, history, and mounted order', () => {
    const parent: PromptProfileEntry[] = [
        { identifier: 'a', mounted: true, enabled: true, lastActiveIndex: 0 },
        { identifier: 'b', mounted: false, enabled: false },
    ];
    const current: PromptProfileEntry[] = [
        { identifier: 'b', mounted: true, enabled: false, lastActiveIndex: 0, fields: { name: 'B' } },
        { identifier: 'a', mounted: false, enabled: true, lastActiveIndex: 0 },
    ];
    assert.deepEqual(diffPromptState(current, parent), {
        changes: [
            { identifier: 'b', mounted: true, lastActiveIndex: 0, fields: { name: 'B' } },
            { identifier: 'a', mounted: false },
        ],
        order: ['b'],
    });
});

test('replacement order drops unknown/new prompts while preserving definitions outside order', () => {
    const entries: PromptProfileEntry[] = [
        { identifier: 'known', mounted: true, enabled: true },
        { identifier: 'missing', mounted: true, enabled: true },
        { identifier: 'unused', mounted: false, enabled: true },
    ];
    assert.deepEqual(replacementPromptOrder(entries, new Set(['known', 'new-preset-prompt'])), [
        { identifier: 'known', enabled: true },
    ]);
});

test('global and character strategies select the same targets as Prompt Manager', () => {
    assert.equal(promptOrderTarget('global', 42), 100001);
    assert.equal(promptOrderTarget(undefined, 42), 100001);
    assert.equal(promptOrderTarget('character', 42), 42);
    assert.equal(promptOrderTarget('character'), 100001);
});
