import { describe, it, expect } from 'vitest';
import {
    applyMigration,
    relockDefaultSnapshot,
    type ConflictResolution,
} from '../src/core/migration/apply.js';
import type { MigrationSource, MigrationTarget } from '../src/core/migration/plan.js';
import type { PromptBaseProfile, PromptDeltaProfile } from '../src/core/domain/types.js';

function baseProfile(overrides: Partial<PromptBaseProfile> = {}): PromptBaseProfile {
    return { formatVersion: 3, kind: 'prompt_base', id: 'b1', name: '主配置', prompts: [], ...overrides };
}

function deltaProfile(overrides: Partial<PromptDeltaProfile> = {}): PromptDeltaProfile {
    return { formatVersion: 3, kind: 'prompt_delta', id: 'd1', name: '派生', baseId: 'b1', changes: [], ...overrides };
}

/**
 * 常用夹具：
 * 旧预设 p1(content A) / p2(content keep) / p3(content stable, 出厂未挂载)
 * 新预设 p1(content B, 出厂 enabled 翻转为 false) / p2(content keep) / p3(出厂挂载) / p4(新增)
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
            { identifier: 'p2', name: '条目二', content: 'keep' },
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

describe('relockDefaultSnapshot', () => {
    it('按新出厂态重锁：mounted 条目带 originalFields，unused 补齐，never-capture 排除', () => {
        const target: MigrationTarget = {
            prompts: [
                { identifier: 'a', name: 'A', content: 'x' },
                { identifier: 'b', name: 'B', content: 'y' },
                { identifier: 'SPresetSettings', name: 'S', content: 'z' },
            ],
            order: [{ identifier: 'a', enabled: false }],
        };
        const snapshot = relockDefaultSnapshot(target);
        expect(snapshot).toEqual([
            { identifier: 'a', mounted: true, enabled: false, lastActiveIndex: 0, originalFields: { name: 'A', content: 'x' } },
            { identifier: 'b', mounted: false, enabled: false, originalFields: { name: 'B', content: 'y' } },
        ]);
    });
});

describe('applyMigration', () => {
    it('未解决冲突 → blocked，返回未解决清单', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [{ identifier: 'p1', mounted: true, enabled: true, fields: { content: 'MY' } }],
        })]);
        const result = applyMigration(source, target, { orderStrategy: 'keep-mine' });
        expect(result.status).toBe('blocked');
        if (result.status === 'blocked') {
            expect(result.unresolved).toHaveLength(1);
            expect(result.unresolved[0]).toMatchObject({ newIdentifier: 'p1', field: 'content', ours: 'MY', theirs: 'B' });
        }
    });

    it('冲突解决后应用：resolution 值生效，等于新定义时净零清除', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [{ identifier: 'p1', mounted: true, enabled: true, fields: { content: 'MY' } }],
        })]);
        const resolutions: ConflictResolution[] = [
            { profileId: 'b1', newIdentifier: 'p1', field: 'content', value: 'B' },
        ];
        const result = applyMigration(source, target, { orderStrategy: 'keep-mine', resolutions });
        expect(result.status).toBe('applied');
        if (result.status !== 'applied') return;
        const migrated = result.meta.profiles[0] as PromptBaseProfile;
        expect(migrated.prompts.find((e) => e.identifier === 'p1')?.fields).toBeUndefined(); // 取新版值 → 净零
        expect(result.report.conflictsResolved).toBe(1);
        expect(result.report.netZeroDropped).toBe(1);
    });

    it('保留用户覆盖：theirs == base 时 ours 原样保留', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [{ identifier: 'p2', mounted: true, enabled: true, fields: { content: 'MY-P2' } }],
        })]);
        const result = applyMigration(source, target, { orderStrategy: 'keep-mine' });
        expect(result.status).toBe('applied');
        if (result.status !== 'applied') return;
        const migrated = result.meta.profiles[0] as PromptBaseProfile;
        expect(migrated.prompts.find((e) => e.identifier === 'p2')?.fields?.content).toBe('MY-P2');
        expect(result.report.preservedOurs).toBe(1);
        // meta 基线来自新预设出厂态（形状细节见 relockDefaultSnapshot 用例）
        expect(result.meta.defaultSnapshot.map((e) => e.identifier)).toEqual(['p1', 'p2', 'p3', 'p4']);
    });

    it('挂载态三方合并：用户翻转保留，未动的跟随新出厂', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [
                { identifier: 'p1', mounted: true, enabled: false }, // 用户关掉（≠base true）→ 保留 false
            ],
        })]);
        const result = applyMigration(source, target, { orderStrategy: 'keep-mine' });
        if (result.status !== 'applied') throw new Error('expected applied');
        const migrated = result.meta.profiles[0] as PromptBaseProfile;
        expect(migrated.prompts.find((e) => e.identifier === 'p1')?.enabled).toBe(false); // ours 保留
        expect(migrated.prompts.find((e) => e.identifier === 'p3')).toBeDefined();       // p3 出厂改挂载、用户未动 → 跟随
    });

    it('旧版仅开关快照（无 mounted 字段）仍按三方语义跟随出厂变化', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [{ identifier: 'p1', mounted: true, enabled: true }], // 用户未动（==base）
        })]);
        // v2 时代旧快照形状：{identifier, enabled}=挂载、无 enabled=unused，缺 mounted
        source.defaultSnapshot = [
            { identifier: 'p1', enabled: true },
            { identifier: 'p2', enabled: true },
            { identifier: 'p3' },
        ] as MigrationSource['defaultSnapshot'];
        const result = applyMigration(source, target, { orderStrategy: 'keep-mine' });
        if (result.status !== 'applied') throw new Error('expected applied');
        const migrated = result.meta.profiles[0] as PromptBaseProfile;
        // 未修复时 base.mounted/enabled=undefined，mergeMount 恒判 ours 有意 → p1 停留 true
        expect(migrated.prompts.find((e) => e.identifier === 'p1')?.enabled).toBe(false);
        expect(result.report.mountFollowed).toBe(1);
    });

    it('mountFollowed 计数：ours == base 且出厂翻转的条目计入', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [{ identifier: 'p1', mounted: true, enabled: true }], // 未动（==base）
        })]);
        const result = applyMigration(source, target, { orderStrategy: 'keep-mine' });
        if (result.status !== 'applied') throw new Error('expected applied');
        const migrated = result.meta.profiles[0] as PromptBaseProfile;
        expect(migrated.prompts.find((e) => e.identifier === 'p1')?.enabled).toBe(false); // 跟随新出厂 false
        expect(result.report.mountFollowed).toBe(1);
    });

    it('新条目默认跟随出厂挂载（已决策），mountNew=unmounted 时一律不挂载', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [{ identifier: 'p1', mounted: true, enabled: true }],
            unusedIds: ['p3'],
        })]);
        const factory = applyMigration(source, target, { orderStrategy: 'keep-mine' });
        if (factory.status !== 'applied') throw new Error('expected applied');
        const factoryBase = factory.meta.profiles[0] as PromptBaseProfile;
        expect(factoryBase.prompts.find((e) => e.identifier === 'p4')).toMatchObject({ mounted: true, enabled: true });
        expect(factory.report.addedMounted).toBeGreaterThanOrEqual(1);
        expect(factoryBase.unusedIds).toBeUndefined(); // p3 出厂已挂载且用户未动 → 跟随挂载，unused 清空

        const unmounted = applyMigration(source, target, { orderStrategy: 'keep-mine', mountNew: 'unmounted' });
        if (unmounted.status !== 'applied') throw new Error('expected applied');
        const unmountedBase = unmounted.meta.profiles[0] as PromptBaseProfile;
        expect(unmountedBase.prompts.find((e) => e.identifier === 'p4')).toBeUndefined();
        expect(unmountedBase.unusedIds).toContain('p4');
    });

    it('keep-mine 顺序：原相对序保留，新条目按新出厂锚点插入', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [
                { identifier: 'p2', mounted: true, enabled: true },
                { identifier: 'p1', mounted: true, enabled: true }, // 用户把 p1 拖到 p2 后
            ],
        })]);
        const result = applyMigration(source, target, { orderStrategy: 'keep-mine' });
        if (result.status !== 'applied') throw new Error('expected applied');
        const migrated = result.meta.profiles[0] as PromptBaseProfile;
        // 新出厂序 p1<p2<p3<p4：p2/p1 保持用户相对序；p3/p4 为补齐条目，按锚点插到尾部
        expect(migrated.prompts.map((e) => e.identifier)).toEqual(['p2', 'p1', 'p3', 'p4']);
    });

    it('follow-new 顺序：按新出厂序排列 mounted 条目', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [
                { identifier: 'p2', mounted: true, enabled: true },
                { identifier: 'p1', mounted: true, enabled: true },
            ],
        })]);
        const result = applyMigration(source, target, { orderStrategy: 'follow-new' });
        if (result.status !== 'applied') throw new Error('expected applied');
        const migrated = result.meta.profiles[0] as PromptBaseProfile;
        expect(migrated.prompts.map((e) => e.identifier)).toEqual(['p1', 'p2', 'p3', 'p4']);
    });

    it('指纹重映射：profile 引用同步换新 id', () => {
        const source: MigrationSource = {
            prompts: [{ identifier: 'old-id', name: '条目', content: 'A' }],
            order: [],
            defaultSnapshot: [{ identifier: 'old-id', mounted: true, enabled: true, originalFields: { content: 'A' } }],
            profiles: [baseProfile({
                prompts: [{ identifier: 'old-id', mounted: true, enabled: true }],
            })],
        };
        const target: MigrationTarget = {
            prompts: [{ identifier: 'new-id', name: '条目', content: 'A' }],
            order: [{ identifier: 'new-id', enabled: true }],
        };
        const result = applyMigration(source, target, { orderStrategy: 'keep-mine' });
        if (result.status !== 'applied') throw new Error('expected applied');
        const migrated = result.meta.profiles[0] as PromptBaseProfile;
        expect(migrated.prompts[0]?.identifier).toBe('new-id');
        expect(result.report.idRemaps).toEqual([['old-id', 'new-id']]);
        expect(result.report.danglingKept).toEqual([]);
    });

    it('dangling 引用保留：挂载态与字段原样，进报告', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [
                { identifier: 'p1', mounted: true, enabled: true },
                { identifier: 'ghost', mounted: true, enabled: true, fields: { content: 'G' } },
            ],
        })]);
        const result = applyMigration(source, target, { orderStrategy: 'keep-mine' });
        if (result.status !== 'applied') throw new Error('expected applied');
        const migrated = result.meta.profiles[0] as PromptBaseProfile;
        expect(migrated.prompts.find((e) => e.identifier === 'ghost')).toMatchObject({ fields: { content: 'G' } });
        expect(result.report.danglingKept).toEqual(['ghost']);
    });

    it('delta 净零：与迁移后父链解析值等价的差异被清除', () => {
        // 父 base 在 p2 上有 content='MY-P2'（迁移后保留）；delta 把 p2 改回 'keep'（== 新定义）
        // → 迁移后 delta 的该条 fields 与父链解析值差 → 保留。
        // 反例：delta 把 p2 覆盖为 'MY-P2'（与父链相同）→ 净零清除。
        const { source, target } = fixture([
            baseProfile({
                prompts: [{ identifier: 'p2', mounted: true, enabled: true, fields: { content: 'MY-P2' } }],
            }),
            deltaProfile({
                baseId: 'b1',
                changes: [{ identifier: 'p2', fields: { content: 'MY-P2' } }], // 与父相同 → 净零
            }),
        ]);
        const result = applyMigration(source, target, { orderStrategy: 'keep-mine' });
        if (result.status !== 'applied') throw new Error('expected applied');
        const delta = result.meta.profiles[1] as PromptDeltaProfile;
        expect(delta.changes).toHaveLength(0);
        expect(result.report.netZeroDropped).toBe(1);
        expect(result.meta.profiles[0].id).toBe('b1');
        expect(result.meta.profiles[1].baseId).toBe('b1'); // 树结构保持
    });

    it('delta 挂载差异净零：与父链一致的 mounted 被清除，不一致的保留', () => {
        const { source, target } = fixture([
            baseProfile({ prompts: [{ identifier: 'p1', mounted: true, enabled: true }] }),
            deltaProfile({
                baseId: 'b1',
                changes: [
                    // mounted 与父链一致 → 净零；enabled 父链已跟随新出厂为 false、本条仍为 true → 差异保留
                    { identifier: 'p1', mounted: true, enabled: true },
                ],
            }),
        ]);
        const result = applyMigration(source, target, { orderStrategy: 'keep-mine' });
        if (result.status !== 'applied') throw new Error('expected applied');
        const delta = result.meta.profiles[1] as PromptDeltaProfile;
        expect(delta.changes).toHaveLength(1);
        expect(delta.changes[0]).toMatchObject({ identifier: 'p1', enabled: true });
        expect(delta.changes[0]?.mounted).toBeUndefined();
    });

    it('sampling / extra 净零：等于新出厂基线的键被清除', () => {
        const { source, target } = fixture([baseProfile({
            prompts: [{ identifier: 'p1', mounted: true, enabled: true }],
            sampling: { temperature: 0.7, top_p: 0.9 },
            extra: { impersonation_prompt: 'x' },
        })]);
        const withBaseline: MigrationTarget = {
            ...target,
            defaultSampling: { temperature: 0.7 },
            defaultExtra: { impersonation_prompt: 'x' },
        };
        const result = applyMigration(source, withBaseline, { orderStrategy: 'keep-mine' });
        if (result.status !== 'applied') throw new Error('expected applied');
        const migrated = result.meta.profiles[0] as PromptBaseProfile;
        expect(migrated.sampling).toEqual({ top_p: 0.9 });
        expect(migrated.extra).toBeUndefined();
        expect(result.meta.defaultSampling).toEqual({ temperature: 0.7 });
    });

    it('成环 delta 保守原样保留，不阻塞其余迁移', () => {
        const { source, target } = fixture([
            baseProfile({ prompts: [{ identifier: 'p1', mounted: true, enabled: true }] }),
            deltaProfile({ id: 'd1', baseId: 'd2', changes: [{ identifier: 'p2', mounted: true }] }),
            deltaProfile({ id: 'd2', baseId: 'd1', changes: [{ identifier: 'p2', mounted: true }] }),
        ]);
        const result = applyMigration(source, target, { orderStrategy: 'keep-mine' });
        if (result.status !== 'applied') throw new Error('expected applied');
        expect(result.meta.profiles[0].kind).toBe('prompt_base');
        // 成环两条原样保留（对象引用不变即未处理）
        expect(result.meta.profiles[1]).toBe(source.profiles[1]);
        expect(result.meta.profiles[2]).toBe(source.profiles[2]);
        expect(result.report.profilesMigrated).toBe(1);
    });
});
