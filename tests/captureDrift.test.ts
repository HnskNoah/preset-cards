import { describe, it, expect } from 'vitest';
import {
    computePromptDrift,
    applyPromptDriftToProfile,
    isEmptyPromptDrift,
} from '../src/core/capture/drift.js';
import type { PromptBaseProfile, PromptDeltaProfile } from '../src/core/domain/types.js';

const runtime = {
    prompts: [
        { identifier: 'p1', content: 'v2', role: 'system', system_prompt: false, marker: false },
        { identifier: 'p2', content: 'same', role: 'user' },
        { identifier: 'p3', content: 'new', role: 'system' },
    ],
    prompt_order: [{ name: 'main', order: [
        { identifier: 'p1', enabled: false },
        { identifier: 'p3', enabled: true },
        { identifier: 'p2', enabled: true },
    ] }],
};

const record = {
    prompts: [
        { identifier: 'p1', content: 'v1', role: 'system', system_prompt: false, marker: false },
        { identifier: 'p2', content: 'same', role: 'user' },
        { identifier: 'pDeleted', content: 'gone', role: 'system' },
    ],
    prompt_order: [{ name: 'main', order: [
        { identifier: 'p1', enabled: true },
        { identifier: 'p2', enabled: true },
        { identifier: 'pDeleted', enabled: true },
    ] }],
};

describe('computePromptDrift', () => {
    it('detects field/enabled/order/delete/add drift between runtime and record', () => {
        const drift = computePromptDrift(runtime as any, record as any);

        expect(drift.changedFields).toEqual([{ identifier: 'p1', fields: { content: 'v2' } }]);
        expect(drift.enabledChanges).toEqual([{ identifier: 'p1', enabled: false }]);
        expect(drift.order).toEqual(['p1', 'p3', 'p2']);
        expect(drift.deleted).toEqual(['pDeleted']);
        expect(drift.unmounted).toEqual([]);
        expect(drift.remounted).toEqual([]);
        expect(drift.added).toEqual([{ identifier: 'p3', definition: expect.objectContaining({ content: 'new' }) }]);
        expect(isEmptyPromptDrift(drift)).toBe(false);
    });

    it('classifies ST detach (removed from order, pool kept) as unmounted, not enabled change', () => {
        const detachRecord = {
            prompts: [
                { identifier: 'p1', content: 'a' },
                { identifier: 'pX', content: 'x' },
            ],
            prompt_order: [{ name: 'main', order: [
                { identifier: 'p1', enabled: true },
                { identifier: 'pX', enabled: false },
            ] }],
        };
        // 运行时：pX 从 order 摘除，但池里还在
        const detachRuntime = {
            prompts: [
                { identifier: 'p1', content: 'a' },
                { identifier: 'pX', content: 'x' },
            ],
            prompt_order: [{ name: 'main', order: [{ identifier: 'p1', enabled: true }] }],
        };

        const drift = computePromptDrift(detachRuntime as any, detachRecord as any);
        expect(drift.unmounted).toEqual(['pX']);   // 摘除 → unmount
        expect(drift.enabledChanges).toEqual([]);  // 不得误判为 enabled:true
        expect(drift.deleted).toEqual([]);         // 池还在,不是删除
        expect(drift.order).toEqual(['p1']);
        expect(isEmptyPromptDrift(drift)).toBe(false);
    });

    it('classifies re-adding a detached prompt (back in order) as remounted', () => {
        const baseRecord = {
            prompts: [
                { identifier: 'p1', content: 'a' },
                { identifier: 'pX', content: 'x' },
            ],
            prompt_order: [{ name: 'main', order: [{ identifier: 'p1', enabled: true }] }],
        };
        const remountRuntime = {
            prompts: [
                { identifier: 'p1', content: 'a' },
                { identifier: 'pX', content: 'x' },
            ],
            prompt_order: [{ name: 'main', order: [
                { identifier: 'p1', enabled: true },
                { identifier: 'pX', enabled: false },
            ] }],
        };

        const drift = computePromptDrift(remountRuntime as any, baseRecord as any);
        expect(drift.remounted).toEqual([{ identifier: 'pX', enabled: false }]);
        expect(isEmptyPromptDrift(drift)).toBe(false);
    });

    it('is empty when runtime matches record', () => {
        const same = structuredClone(record);
        const drift = computePromptDrift(same as any, record as any);
        expect(isEmptyPromptDrift(drift)).toBe(true);
    });
});

describe('applyPromptDriftToProfile (base)', () => {
    const base: PromptBaseProfile = {
        formatVersion: 3,
        kind: 'prompt_base',
        id: 'B',
        name: '战斗版',
        prompts: [
            { identifier: 'p1', mounted: true, enabled: true, fields: { content: 'v1' } },
            { identifier: 'p2', mounted: true, enabled: true },
            { identifier: 'pDeleted', mounted: true, enabled: true },
        ],
        unusedIds: [],
    };

    it('merges fields/enabled, unmounts deleted, mounts added, reorders by runtime order', () => {
        const drift = computePromptDrift(runtime as any, record as any);
        const next = applyPromptDriftToProfile(base, drift) as PromptBaseProfile;

        const p1 = next.prompts.find((e) => e.identifier === 'p1')!;
        expect(p1.fields).toEqual({ content: 'v2' });
        expect(p1.enabled).toBe(false);
        const pDeleted = next.prompts.find((e) => e.identifier === 'pDeleted')!;
        expect(pDeleted.mounted).toBe(false);
        expect(pDeleted.enabled).toBe(false); // 删除 = unmount + 禁用（渲染开关读 enabled）
        expect(next.prompts.find((e) => e.identifier === 'p3')).toMatchObject({ mounted: true, enabled: true, fields: { content: 'new' } });
        // mounted 顺序 = 运行时顺序
        expect(next.prompts.filter((e) => e.mounted).map((e) => e.identifier)).toEqual(['p1', 'p3', 'p2']);
        expect(next.unusedIds).toContain('pDeleted');
    });

    it('applies ST detach as unmount and re-add as remount', () => {
        const detachBase: PromptBaseProfile = {
            formatVersion: 3,
            kind: 'prompt_base',
            id: 'B',
            name: 'x',
            prompts: [
                { identifier: 'p1', mounted: true, enabled: true },
                { identifier: 'pX', mounted: true, enabled: false },
            ],
            unusedIds: [],
        };
        const detachRecord = {
            prompts: [
                { identifier: 'p1', content: 'a' },
                { identifier: 'pX', content: 'x' },
            ],
            prompt_order: [{ name: 'main', order: [
                { identifier: 'p1', enabled: true },
                { identifier: 'pX', enabled: false },
            ] }],
        };
        const detachRuntime = {
            prompts: [
                { identifier: 'p1', content: 'a' },
                { identifier: 'pX', content: 'x' },
            ],
            prompt_order: [{ name: 'main', order: [{ identifier: 'p1', enabled: true }] }],
        };
        const drift = computePromptDrift(detachRuntime as any, detachRecord as any);
        const next = applyPromptDriftToProfile(detachBase, drift) as PromptBaseProfile;
        const pX = next.prompts.find((e) => e.identifier === 'pX')!;
        expect(pX.mounted).toBe(false);
        expect(pX.enabled).toBe(false);
        expect(next.unusedIds).toContain('pX');
        // mounted 顺序不再含 pX
        expect(next.prompts.filter((e) => e.mounted).map((e) => e.identifier)).not.toContain('pX');

        // 重新挂载
        const remountRuntime = structuredClone(detachRecord);
        const remountDrift = computePromptDrift(remountRuntime as any, detachRuntime as any);
        const remounted = applyPromptDriftToProfile(next, remountDrift) as PromptBaseProfile;
        const pX2 = remounted.prompts.find((e) => e.identifier === 'pX')!;
        expect(pX2.mounted).toBe(true);
        expect(remounted.unusedIds ?? []).not.toContain('pX');
    });

    it('no-op when no drift', () => {
        const drift = computePromptDrift(structuredClone(record) as any, record as any);
        expect(applyPromptDriftToProfile(base, drift)).toEqual(base);
    });
});

describe('applyPromptDriftToProfile (delta)', () => {
    const delta: PromptDeltaProfile = {
        formatVersion: 3,
        kind: 'prompt_delta',
        id: 'D',
        name: '日常版',
        baseId: 'B',
        changes: [
            { identifier: 'p1', fields: { content: 'v1' } },
            { identifier: 'pDeleted', mounted: true },
        ],
        order: ['p1', 'p2', 'pDeleted'],
    };

    it('merges changes, unmounts deleted, mounts added, writes order', () => {
        const drift = computePromptDrift(runtime as any, record as any);
        const next = applyPromptDriftToProfile(delta, drift) as PromptDeltaProfile;

        const p1 = next.changes.find((c) => c.identifier === 'p1')!;
        expect(p1.fields).toEqual({ content: 'v2' });
        expect(p1.enabled).toBe(false);
        const del = next.changes.find((c) => c.identifier === 'pDeleted')!;
        expect(del.mounted).toBe(false);
        expect(del.enabled).toBe(false); // 删除 = unmount + 禁用
        const added = next.changes.find((c) => c.identifier === 'p3')!;
        expect(added).toMatchObject({ mounted: true, enabled: true, fields: { content: 'new' } });
        expect(next.order).toEqual(['p1', 'p3', 'p2']);
    });
});
