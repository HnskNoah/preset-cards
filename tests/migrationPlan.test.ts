import { describe, it, expect } from 'vitest';
import {
    matchPromptPools,
    buildMigrationPlan,
    type PromptPoolEntry,
    type MigrationSource,
    type MigrationTarget,
} from '../src/core/migration/plan.js';
import type { PromptBaseProfile, PromptDeltaProfile } from '../src/core/domain/types.js';

function pool(entries: Record<string, any>[]): PromptPoolEntry[] {
    return entries.map((e) => ({ identifier: e.identifier, def: e }));
}

function baseProfile(overrides: Partial<PromptBaseProfile> = {}): PromptBaseProfile {
    return {
        formatVersion: 3,
        kind: 'prompt_base',
        id: 'b1',
        name: '主配置',
        prompts: [],
        ...overrides,
    };
}

function deltaProfile(overrides: Partial<PromptDeltaProfile> = {}): PromptDeltaProfile {
    return {
        formatVersion: 3,
        kind: 'prompt_delta',
        id: 'd1',
        name: '派生',
        baseId: 'b1',
        changes: [],
        ...overrides,
    };
}

describe('matchPromptPools', () => {
    it('identifier 精确匹配：内容未变', () => {
        const result = matchPromptPools(
            pool([{ identifier: 'p1', content: 'A', name: 'N1' }]),
            pool([{ identifier: 'p1', content: 'A', name: 'N1' }]),
        );
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]).toMatchObject({ oldIdentifier: 'p1', newIdentifier: 'p1', method: 'id', definitionChanged: false });
        expect(result.idRemap.size).toBe(0);
    });

    it('identifier 匹配但内容已改：仍视为同条目，记录 changedFields', () => {
        const result = matchPromptPools(
            pool([{ identifier: 'p1', content: 'A', injection_depth: 4 }]),
            pool([{ identifier: 'p1', content: 'B', injection_depth: 4 }]),
        );
        expect(result.matches[0]).toMatchObject({ method: 'id', definitionChanged: true, changedFields: ['content'] });
    });

    it('identifier 变了内容没变：指纹匹配 + id 重映射（null 与缺省键视为等价）', () => {
        const result = matchPromptPools(
            pool([{ identifier: 'old-id', content: 'A', role: 'system', name: null }]),
            pool([{ identifier: 'new-id', content: 'A', role: 'system', marker: true }]),
        );
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]).toMatchObject({ oldIdentifier: 'old-id', newIdentifier: 'new-id', method: 'fingerprint', definitionChanged: false });
        expect(result.idRemap.get('old-id')).toBe('new-id');
    });

    it('新增与删除条目分别归入 added / removed', () => {
        const result = matchPromptPools(
            pool([{ identifier: 'keep', content: 'A' }, { identifier: 'gone', content: 'B' }]),
            pool([{ identifier: 'keep', content: 'A' }, { identifier: 'fresh', content: 'C' }]),
        );
        expect(result.added.map((e) => e.identifier)).toEqual(['fresh']);
        expect(result.removed.map((e) => e.identifier)).toEqual(['gone']);
    });

    it('指纹在任一侧不唯一：不自动匹配，计入 ambiguous', () => {
        const result = matchPromptPools(
            pool([{ identifier: 'a1', content: '' }, { identifier: 'a2', content: '' }]),
            pool([{ identifier: 'b1', content: '' }, { identifier: 'b2', content: '' }]),
        );
        expect(result.matches).toHaveLength(0);
        expect(result.ambiguous).toBe(2);
        expect(result.added).toHaveLength(2);
        expect(result.removed).toHaveLength(2);
    });
});

describe('buildMigrationPlan', () => {
    /**
     * 常用旧/新预设视图：
     * - p1：作者改了 content（A→B）与出厂 enabled（true→false）
     * - p2：作者只改了 name（条目二→条目二新）
     * - p3：内容稳定，出厂挂载 false→true
     */
    function fixture(profiles: (PromptBaseProfile | PromptDeltaProfile)[]) {
        const source: MigrationSource = {
            prompts: [
                { identifier: 'p1', name: '条目一', content: 'A', role: 'system' },
                { identifier: 'p2', name: '条目二', content: 'keep' },
                { identifier: 'p3', name: '条目三', content: 'stable' },
            ],
            order: [
                { identifier: 'p1', enabled: true },
                { identifier: 'p2', enabled: true },
            ],
            defaultSnapshot: [
                { identifier: 'p1', mounted: true, enabled: true, originalFields: { content: 'A', role: 'system' } },
                { identifier: 'p2', mounted: true, enabled: true, originalFields: { content: 'keep' } },
                { identifier: 'p3', mounted: false, enabled: true, originalFields: { content: 'stable' } },
            ],
            profiles,
        };
        const target: MigrationTarget = {
            prompts: [
                { identifier: 'p1', name: '条目一', content: 'B', role: 'user' },
                { identifier: 'p2', name: '条目二新', content: 'keep' },
                { identifier: 'p3', name: '条目三', content: 'stable' },
            ],
            order: [
                { identifier: 'p1', enabled: false },
                { identifier: 'p2', enabled: true },
                { identifier: 'p3', enabled: true },
            ],
        };
        return { source, target };
    }

    it('字段冲突：profile 与作者改了同一字段且值不同', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [{ identifier: 'p1', mounted: true, enabled: true, fields: { content: 'MY-EDIT' } }],
        })]);
        const plan = buildMigrationPlan(source, target);
        const report = plan.profileReports[0];
        expect(report.fieldConflicts).toHaveLength(1);
        expect(report.fieldConflicts[0]).toMatchObject({
            newIdentifier: 'p1', entryName: '条目一', field: 'content', base: 'A', ours: 'MY-EDIT', theirs: 'B',
        });
        expect(plan.summary.conflicts).toBe(1);
    });

    it('自动跟随：profile 未改的字段不产生冲突（即使作者改了）', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [{ identifier: 'p1', mounted: true, enabled: true }],
        })]);
        const plan = buildMigrationPlan(source, target);
        expect(plan.profileReports[0].fieldConflicts).toHaveLength(0);
        expect(plan.summary.definitionChanged).toBe(2); // p1 与 p2 定义有变
    });

    it('保留 ours：profile 改了但作者没改（theirs == base）', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [{ identifier: 'p2', mounted: true, enabled: true, fields: { content: 'MY-P2' } }],
        })]);
        const plan = buildMigrationPlan(source, target);
        expect(plan.profileReports[0].fieldConflicts).toHaveLength(0);
    });

    it('殊途同归：ours 与 theirs 值相同不算冲突', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [{ identifier: 'p1', mounted: true, enabled: true, fields: { content: 'B' } }],
        })]);
        const plan = buildMigrationPlan(source, target);
        expect(plan.profileReports[0].fieldConflicts).toHaveLength(0);
    });

    it('布尔三方合并结构性无冲突：用户翻转与作者翻转必然同向收敛', () => {
        // p1 enabled：base=true、profile 翻转为 false、新出厂也翻转为 false → 收敛，非冲突
        // （mountStateChanges 的上报内容另见「出厂挂载态变化逐项上报」用例）
        const { source, target } = fixture([baseProfile({
            prompts: [{ identifier: 'p1', mounted: true, enabled: false }],
        })]);
        const plan = buildMigrationPlan(source, target);
        expect(plan.profileReports[0].fieldConflicts).toHaveLength(0);
    });

    it('出厂挂载态变化逐项上报（自动跟随项）', () => {
        const { source, target } = fixture([]);
        const plan = buildMigrationPlan(source, target);
        expect(plan.mountStateChanges).toContainEqual({ newIdentifier: 'p1', field: 'enabled', base: true, theirs: false });
        expect(plan.mountStateChanges).toContainEqual({ newIdentifier: 'p3', field: 'mounted', base: false, theirs: true });
    });

    it('dangling 引用：profile 引用了新预设删除的条目（含 unusedIds）', () => {
        const { source, target } = fixture([]);
        const withRemoved: MigrationSource = {
            ...source,
            prompts: [
                ...source.prompts,
                { identifier: 'gone-ref', name: '已删', content: 'x' },
                { identifier: 'unused-gone', name: '未挂载已删', content: 'y' },
            ],
            profiles: [baseProfile({
                prompts: [{ identifier: 'gone-ref', mounted: true, enabled: true }],
                unusedIds: ['unused-gone'],
            })],
        };
        const plan = buildMigrationPlan(withRemoved, target);
        expect(plan.profileReports[0].danglingReferences).toEqual(['gone-ref', 'unused-gone']);
        expect(plan.summary.removed).toBe(2);
    });

    it('defaultSnapshot 缺失：字段 base 回退旧定义取值', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [{ identifier: 'p1', mounted: true, enabled: true, fields: { content: 'X' } }],
        })]);
        const noSnapshot: MigrationSource = { ...source, defaultSnapshot: undefined };
        const plan = buildMigrationPlan(noSnapshot, target);
        // base 回退旧定义 content='A'，ours='X' ≠ base、theirs='B' ≠ base → 冲突
        expect(plan.profileReports[0].fieldConflicts[0]).toMatchObject({ field: 'content', base: 'A', ours: 'X', theirs: 'B' });
    });

    it('delta：sparse 条目参与冲突检测，order 记入 hasExplicitOrder', () => {
        const { source, target } = fixture([deltaProfile({
            changes: [
                { identifier: 'p1', fields: { content: 'DELTA-EDIT' } },
                { identifier: 'p3', mounted: true },
            ],
            order: ['p1', 'p3'],
        })]);
        const plan = buildMigrationPlan(source, target);
        const report = plan.profileReports[0];
        expect(report.fieldConflicts).toHaveLength(1);
        expect(report.fieldConflicts[0]).toMatchObject({ field: 'content', base: 'A', ours: 'DELTA-EDIT', theirs: 'B' });
        expect(report.hasExplicitOrder).toBe(true);
        expect(report.danglingReferences).toHaveLength(0);
    });

    it('指纹重映射条目：匹配成功则引用不算 dangling，上报用新 identifier', () => {
        const source: MigrationSource = {
            prompts: [{ identifier: 'old-id', name: '改名条目', content: 'A' }],
            order: [],
            defaultSnapshot: [{ identifier: 'old-id', mounted: false, enabled: true, originalFields: { content: 'A' } }],
            profiles: [baseProfile({
                prompts: [{ identifier: 'old-id', mounted: true, enabled: true }],
            })],
        };
        const target: MigrationTarget = {
            prompts: [{ identifier: 'new-id', name: '改名条目', content: 'A' }],
            order: [{ identifier: 'new-id', enabled: true }],
        };
        const plan = buildMigrationPlan(source, target);
        expect(plan.summary.fingerprintRemapped).toBe(1);
        expect(plan.profileReports[0].danglingReferences).toHaveLength(0);
        expect(plan.mountStateChanges).toContainEqual({ newIdentifier: 'new-id', field: 'mounted', base: false, theirs: true });
    });

    it('identifier 与内容都变了：互不匹配，引用判 dangling', () => {
        const source: MigrationSource = {
            prompts: [{ identifier: 'old-id', name: '条目', content: 'A' }],
            order: [{ identifier: 'old-id', enabled: true }],
            defaultSnapshot: [{ identifier: 'old-id', mounted: true, enabled: true, originalFields: { content: 'A' } }],
            profiles: [baseProfile({
                prompts: [{ identifier: 'old-id', mounted: true, enabled: true, fields: { content: 'MY' } }],
            })],
        };
        const target: MigrationTarget = {
            prompts: [{ identifier: 'new-id', name: '条目', content: 'A-REWRITTEN' }],
            order: [{ identifier: 'new-id', enabled: true }],
        };
        const plan = buildMigrationPlan(source, target);
        expect(plan.summary.fingerprintRemapped).toBe(0);
        expect(plan.profileReports[0].danglingReferences).toEqual(['old-id']);
        expect(plan.summary.added).toBe(1);
        expect(plan.summary.removed).toBe(1);
    });
});
