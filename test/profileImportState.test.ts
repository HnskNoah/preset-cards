import assert from 'node:assert/strict';
import test from 'node:test';
import {
    prepareImportedBaseProfile,
    prepareImportedTree,
} from '../src/profileImportState.ts';

test('imported base fields are rebased from source defaults to local defaults', () => {
    const imported = prepareImportedBaseProfile({
        formatVersion: 3,
        kind: 'prompt_base',
        id: 'base',
        name: 'Base',
        prompts: [
            { identifier: 'a', mounted: true, enabled: true },
            { identifier: 'b', mounted: false, enabled: false, fields: { name: 'Source B', arbitrary_secret: 'drop' } as never },
        ],
    }, [
        { identifier: 'a', mounted: true, enabled: true, originalFields: { content: 'A' } },
        { identifier: 'b', mounted: false, enabled: false, originalFields: { name: 'Source B' } },
    ], [
        { identifier: 'a', mounted: true, enabled: true, originalFields: { content: 'B' } },
        { identifier: 'b', mounted: false, enabled: false, originalFields: { name: 'Local B' } },
    ]);

    assert.deepEqual(imported.prompts, [
        { identifier: 'a', mounted: true, enabled: true, fields: { content: 'A' } },
        { identifier: 'b', mounted: false, enabled: false, fields: { name: 'Source B' } },
    ]);
});

test('tree import remaps child-before-parent references after allocating all ids', () => {
    const base = {
        formatVersion: 3 as const,
        kind: 'prompt_base' as const,
        id: 'parent',
        name: 'Parent',
        prompts: [{ identifier: 'a', mounted: true, enabled: true }],
    };
    const delta = {
        formatVersion: 3 as const,
        kind: 'prompt_delta' as const,
        id: 'child',
        name: 'Child',
        baseId: 'parent',
        changes: [],
    };
    let next = 0;
    const result = prepareImportedTree([delta, base], 'Loaded', 'child', () => String(++next));
    assert.equal(result.missingBaseIds.length, 0);
    assert.equal(result.profiles[0].kind, 'prompt_delta');
    assert.equal(result.profiles[0].baseId, result.profiles[1].id);
    assert.equal(result.profiles[0].name, 'Loaded');
});
