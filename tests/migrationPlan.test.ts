import { describe, it, expect } from 'vitest';
import {
    matchPromptPools,
    type PromptPoolEntry,
    type MigrationSource,
    type MigrationTarget,
} from '../src/core/migration/plan.js';
import { analyzeMigration, previewMigration } from '../src/core/migration/apply.js';
import type { ConflictResolution } from '../src/core/migration/replay.js';
import type { PromptBaseProfile, PromptDeltaProfile } from '../src/core/domain/types.js';

function pool(entries: Record<string, any>[]): PromptPoolEntry[] {
    return entries.map((e) => ({ identifier: e.identifier, def: e }));
}

function baseProfile(overrides: Partial<PromptBaseProfile> = {}): PromptBaseProfile {
    return { formatVersion: 3, kind: 'prompt_base', id: 'b1', name: '主配置', prompts: [], ...overrides };
}

function deltaProfile(overrides: Partial<PromptDeltaProfile> = {}): PromptDeltaProfile {
    return { formatVersion: 3, kind: 'prompt_delta', id: 'd1', name: '派生', baseId: 'b1', changes: [], ...overrides };
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

/**
 * 常用夹具（v2 逐层重放语义）：
 * 旧预设 p1(content A) / p2(content keep) / p3(content stable, 出厂未挂载)
 * 新预设 p1(content B, 出厂 enabled 翻转为 false) / p2(仅改名) / p3(出厂挂载) / p4(新增)
 */
function fixture(profiles: (PromptBaseProfile | PromptDeltaProfile)[]) {
    const source: MigrationSource = {
        prompts: [
            { identifier: 'p1', name: '条目一', content: 'A' },
            { identifier: 'p2', name: '条目二', content: 'keep' },
            { identifier: 'p3', name: '条目三', content: 'stable' },
        ],
        order: [
            { identifier: 'p1', enabled: true },
            { identifier: 'p2', enabled: true },
        ],
        defaultSnapshot: [
            { identifier: 'p1', mounted: true, enabled: true, originalFields: { content: 'A' } },
            { identifier: 'p2', mounted: true, enabled: true, originalFields: { content: 'keep' } },
            { identifier: 'p3', mounted: false, enabled: true, originalFields: { content: 'stable' } },
        ],
        profiles,
    };
    const target: MigrationTarget = {
        prompts: [
            { identifier: 'p1', name: '条目一', content: 'B' },
            { identifier: 'p2', name: '条目二新', content: 'keep' },
            { identifier: 'p3', name: '条目三', content: 'stable' },
            { identifier: 'p4', name: '新增条目', content: 'new' },
        ],
        order: [
            { identifier: 'p1', enabled: false },
            { identifier: 'p2', enabled: true },
            { identifier: 'p3', enabled: true },
            { identifier: 'p4', enabled: true },
        ],
    };
    return { source, target };
}

describe('analyzeMigration（逐层重放分析）', () => {
    it('Base 层字段冲突：三方 = 出厂基线 / profile diff / 新定义', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [{ identifier: 'p1', mounted: true, enabled: true, fields: { content: 'MY-EDIT' } }],
        })]);
        const result = analyzeMigration(source, target);
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0]).toMatchObject({
            profileId: 'b1', kind: 'prompt_base', chainLevel: 0,
            newIdentifier: 'p1', entryName: '条目一', field: 'content',
            base: 'A', ours: 'MY-EDIT', theirs: 'B',
        });
        expect(result.summary.conflicts).toBe(1);
        expect(result.summary.definitionChanged).toBe(2); // p1 与 p2 定义有变
    });

    it('自动跟随 / 保留 ours / 殊途同归：均不产生冲突', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [
                { identifier: 'p1', mounted: true, enabled: true },            // 未改 → 跟随
                { identifier: 'p2', mounted: true, enabled: true, fields: { content: 'MY-P2' } }, // 作者没改 content → 保留
            ],
        })]);
        const result = analyzeMigration(source, target);
        expect(result.conflicts).toHaveLength(0);

        const { source: s2, target: t2 } = fixture([baseProfile({
            prompts: [{ identifier: 'p1', mounted: true, enabled: true, fields: { content: 'B' } }], // 殊途同归
        })]);
        expect(analyzeMigration(s2, t2).conflicts).toHaveLength(0);
    });

    it('布尔挂载态结构性无冲突；出厂挂载变化进 mountStateChanges', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [{ identifier: 'p1', mounted: true, enabled: false }], // 用户翻转（≠base true）
        })]);
        const result = analyzeMigration(source, target);
        expect(result.conflicts).toHaveLength(0);
        expect(result.mountStateChanges).toContainEqual({ newIdentifier: 'p1', field: 'enabled', base: true, theirs: false });
        expect(result.mountStateChanges).toContainEqual({ newIdentifier: 'p3', field: 'mounted', base: false, theirs: true });
    });

    it('delta 层冲突基准：预览按「全部保我的」假设展开——父解析未变时 delta 无冲突', () => {
        // 父 Base 覆盖 content=MY；delta 再覆盖为 D1。
        // 无 resolutions 的预览假设 Base 最终取 MY（ours）→ 迁移后父解析 == 旧父解析 → delta 不冲突。
        // （delta 冲突何时出现见下一条多层重放用例。）
        const { source, target } = fixture([
            baseProfile({ prompts: [{ identifier: 'p1', mounted: true, enabled: true, fields: { content: 'MY' } }] }),
            deltaProfile({ changes: [{ identifier: 'p1', fields: { content: 'D1' } }] }),
        ]);
        const result = analyzeMigration(source, target);
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0]).toMatchObject({ profileId: 'b1', kind: 'prompt_base', base: 'A', ours: 'MY', theirs: 'B' });
        // delta 保留自己的差异（D1 ≠ 父解析 MY）
        const delta = result.profiles[1] as PromptDeltaProfile;
        expect(delta.changes.find((c) => c.identifier === 'p1')?.fields?.content).toBe('D1');
    });

    it('多层重放核心语义：上层保我的 → 下层冲突消失；上层跟新版 → 下层冲突出现', () => {
        const { source, target } = fixture([
            baseProfile({ prompts: [{ identifier: 'p1', mounted: true, enabled: true, fields: { content: 'MY' } }] }),
            deltaProfile({ changes: [{ identifier: 'p1', fields: { content: 'D1' } }] }),
        ]);
        const baseResolution: ConflictResolution = { profileId: 'b1', newIdentifier: 'p1', field: 'content', value: 'MY' };
        // 上层（Base）保我的（MY）→ 旧父解析 == 迁移后父解析 → delta 无冲突
        const keepOurs = previewMigration(source, target, { orderStrategy: 'keep-mine', resolutions: [baseResolution] });
        expect(keepOurs.conflicts).toHaveLength(0);
        // delta 保留自己的 D1（与父解析 MY 不同）
        const deltaKept = keepOurs.profiles[1] as PromptDeltaProfile;
        expect(deltaKept.changes.find((c) => c.identifier === 'p1')?.fields?.content).toBe('D1');

        // 上层（Base）跟新版（B）→ 迁移后父解析变 B → delta 冲突出现（base=MY、theirs=B）
        const followNew = previewMigration(source, target, {
            orderStrategy: 'keep-mine',
            resolutions: [{ profileId: 'b1', newIdentifier: 'p1', field: 'content', value: 'B' }],
        });
        expect(followNew.conflicts).toHaveLength(1);
        expect(followNew.conflicts[0]).toMatchObject({ kind: 'prompt_delta', base: 'MY', ours: 'D1', theirs: 'B' });
    });

    it('残留 resolution 不消费：冲突因上层重选蒸发后，手动编辑值不得写入（含计数）', () => {
        const { source, target } = fixture([
            baseProfile({ prompts: [{ identifier: 'p1', mounted: true, enabled: true, fields: { content: 'MY' } }] }),
            deltaProfile({ changes: [{ identifier: 'p1', fields: { content: 'D1' } }] }),
        ]);
        // 上层改选保我的(MY) → delta 三方收敛（theirs===baseVal===MY）→ 冲突消失
        const stale = previewMigration(source, target, {
            orderStrategy: 'keep-mine',
            resolutions: [
                { profileId: 'b1', newIdentifier: 'p1', field: 'content', value: 'MY' },
                { profileId: 'd1', newIdentifier: 'p1', field: 'content', value: 'Z' }, // 残留
            ],
        });
        expect(stale.conflicts).toHaveLength(0);
        const delta = stale.profiles[1] as PromptDeltaProfile;
        expect(delta.changes.find((c) => c.identifier === 'p1')?.fields?.content).toBe('D1'); // 非 Z
        expect(stale.report.conflictsResolved).toBe(1); // 只消费上层那次真冲突解决

        // 真冲突仍在时决策照常生效（防矫枉过正）
        const live = previewMigration(source, target, {
            orderStrategy: 'keep-mine',
            resolutions: [
                { profileId: 'b1', newIdentifier: 'p1', field: 'content', value: 'B' },
                { profileId: 'd1', newIdentifier: 'p1', field: 'content', value: 'X' },
            ],
        });
        expect(live.conflicts).toHaveLength(0);
        const deltaLive = live.profiles[1] as PromptDeltaProfile;
        expect(deltaLive.changes.find((c) => c.identifier === 'p1')?.fields?.content).toBe('X');
    });

    it('dangling 引用进报告（含 unusedIds）；指纹重映射后不算 dangling', () => {
        const { source, target } = fixture([]);
        const withRemoved: MigrationSource = {
            ...source,
            prompts: [...source.prompts, { identifier: 'gone-ref', name: '已删', content: 'x' }],
            profiles: [baseProfile({
                prompts: [{ identifier: 'gone-ref', mounted: true, enabled: true }],
                unusedIds: ['unused-gone'],
            })],
        };
        const result = analyzeMigration(withRemoved, target);
        expect(result.report.danglingKept).toEqual(['gone-ref', 'unused-gone']);
        expect(result.summary.removed).toBe(1); // 只有进了旧池的 gone-ref 算删除条目

        const src: MigrationSource = {
            prompts: [{ identifier: 'old-id', name: '改名条目', content: 'A' }],
            order: [],
            defaultSnapshot: [{ identifier: 'old-id', mounted: false, enabled: true, originalFields: { content: 'A' } }],
            profiles: [baseProfile({ prompts: [{ identifier: 'old-id', mounted: true, enabled: true }] })],
        };
        const tgt: MigrationTarget = {
            prompts: [{ identifier: 'new-id', name: '改名条目', content: 'A' }],
            order: [{ identifier: 'new-id', enabled: true }],
        };
        const remapped = analyzeMigration(src, tgt);
        expect(remapped.summary.fingerprintRemapped).toBe(1);
        expect(remapped.report.danglingKept).toHaveLength(0);
        expect(remapped.mountStateChanges).toContainEqual({ newIdentifier: 'new-id', field: 'mounted', base: false, theirs: true });
    });

    it('defaultSnapshot 缺失：Base 字段 base 回退旧定义取值', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [{ identifier: 'p1', mounted: true, enabled: true, fields: { content: 'X' } }],
        })]);
        const noSnapshot: MigrationSource = { ...source, defaultSnapshot: undefined };
        const result = analyzeMigration(noSnapshot, target);
        expect(result.conflicts[0]).toMatchObject({ field: 'content', base: 'A', ours: 'X', theirs: 'B' });
    });
});
