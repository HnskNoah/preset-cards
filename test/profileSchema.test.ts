import assert from 'node:assert/strict';
import test from 'node:test';
import {
    assertV3ImportPayload,
    isV3BaseProfileData,
    isV3DeltaProfileData,
    LegacyProfileFormatError,
} from '../src/profileSchema.ts';

const base = {
    formatVersion: 3,
    kind: 'prompt_base',
    id: 'base',
    name: 'Base',
    prompts: [{ identifier: 'a', mounted: true, enabled: true, lastActiveIndex: 0 }],
};

const delta = {
    formatVersion: 3,
    kind: 'prompt_delta',
    id: 'delta',
    name: 'Delta',
    baseId: 'base',
    changes: [{ identifier: 'a', mounted: false, lastActiveIndex: 0 }],
    order: [],
};

test('only complete v3 base and delta profiles are operable', () => {
    assert.equal(isV3BaseProfileData(base), true);
    assert.equal(isV3DeltaProfileData(delta), true);
    assert.equal(isV3BaseProfileData({ ...base, formatVersion: 2 }), false);
    assert.equal(isV3BaseProfileData({ ...base, prompts: [{ identifier: 'a', enabled: true }] }), false);
});

test('v3 fields are limited to the persisted whitelist and expected value types', () => {
    assert.equal(isV3BaseProfileData({
        ...base,
        prompts: [{ identifier: 'a', mounted: true, enabled: true, fields: { content: 'ok', injection_depth: 2 } }],
    }), true);
    assert.equal(isV3BaseProfileData({
        ...base,
        prompts: [{ identifier: 'a', mounted: true, enabled: true, fields: { arbitrary_secret: 'nope' } }],
    }), false);
    assert.equal(isV3DeltaProfileData({
        ...delta,
        changes: [{ identifier: 'a', fields: { injection_depth: '2' } }],
    }), false);
});

test('tree import preserves v3 mounted/history/order data', () => {
    const tree = { kind: 'prompt_tree', formatVersion: 3, profiles: [base, delta] };
    assert.doesNotThrow(() => assertV3ImportPayload(tree));
    assert.deepEqual(tree.profiles[0].prompts[0], base.prompts[0]);
    assert.deepEqual(tree.profiles[1].order, []);
});

test('v1/v2 individual and mixed-tree imports are explicitly rejected', () => {
    const legacy = { ...base, formatVersion: 2 };
    assert.throws(() => assertV3ImportPayload(legacy), LegacyProfileFormatError);
    assert.throws(
        () => assertV3ImportPayload({ kind: 'prompt_tree', formatVersion: 3, profiles: [base, legacy] }),
        LegacyProfileFormatError,
    );
});
