import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetOpenaiMock, addPreset, openai_settings, openai_setting_names } from './mocks/openai.js';
import {
    buildMigrationSource,
    buildMigrationTarget,
    planMigration,
    executeMigration,
    listMigrationSourceNames,
} from '../src/presetMigration.js';
import { readMeta } from '../src/meta.js';
import { readPresetMarker } from '../src/core/storage/marker.js';
import { initPresetRegistration } from '../src/presetRegistration.js';

// 落盘 → onMetaPersisted → sync 自动注册投影（init 的接线在测试里显式注册一次）
initPresetRegistration();

/** 轮询等待异步注册完成（20ms × 最多 2s）。 */
async function waitFor(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 100; i++) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 20));
    }
}

/** 旧预设：p1（用户改过 content）+ p2（未动）+ profile 树（base + delta）。 */
function oldPresetFixture(): Record<string, any> {
    return {
        name: 'Midnight',
        prompts: [
            { identifier: 'p1', name: '条目一', content: 'v1', role: 'system', system_prompt: false, marker: false },
            { identifier: 'p2', name: '条目二', content: 'keep', role: 'system', system_prompt: false, marker: false },
        ],
        prompt_order: [{ name: 'main', character_id: 100001, order: [
            { identifier: 'p1', enabled: true },
            { identifier: 'p2', enabled: true },
        ] }],
        temperature: 0.7,
        extensions: {
            preset_cards: {
                description: '',
                models: [],
                bgImage: '',
                profiles: [
                    {
                        formatVersion: 3,
                        kind: 'prompt_base',
                        id: 'b1',
                        name: '主配置',
                        prompts: [
                            { identifier: 'p1', mounted: true, enabled: true, fields: { content: 'MY' } },
                            { identifier: 'p2', mounted: true, enabled: true },
                        ],
                    },
                    {
                        formatVersion: 3,
                        kind: 'prompt_delta',
                        id: 'd1',
                        name: '战斗版',
                        baseId: 'b1',
                        changes: [{ identifier: 'p2', enabled: false }],
                    },
                ],
                defaultSnapshotLocked: true,
                defaultSnapshot: [
                    { identifier: 'p1', mounted: true, enabled: true, originalFields: { content: 'v1', role: 'system' } },
                    { identifier: 'p2', mounted: true, enabled: true, originalFields: { content: 'keep' } },
                ],
            },
        },
    };
}

/** 新预设：p1 作者改 content（与用户 MY 冲突）、p3 新增；出厂挂 p1/p3。 */
function newPresetFixture(): Record<string, any> {
    return {
        name: 'Midnight v2',
        prompts: [
            { identifier: 'p1', name: '条目一', content: 'v2', role: 'system', system_prompt: false, marker: false },
            { identifier: 'p3', name: '新增条目', content: 'new', role: 'system', system_prompt: false, marker: false },
        ],
        prompt_order: [{ name: 'main', character_id: 100001, order: [
            { identifier: 'p1', enabled: true },
            { identifier: 'p3', enabled: true },
        ] }],
        temperature: 0.8,
        extensions: { preset_cards: { description: '', models: [], bgImage: '', profiles: [] } },
    };
}

beforeEach(() => {
    resetOpenaiMock();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true } as Response)));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('presetMigration 适配层', () => {
    it('buildMigrationSource：取目标策略 order + 全部 v3 profiles + 出厂基线', () => {
        const src = buildMigrationSource(oldPresetFixture() as any);
        expect(src.order).toEqual([
            { identifier: 'p1', enabled: true },
            { identifier: 'p2', enabled: true },
        ]);
        expect(src.profiles.map((p) => p.id)).toEqual(['b1', 'd1']);
        expect(src.defaultSnapshot).toHaveLength(2);
    });

    it('buildMigrationTarget：采集新出厂基线（sampling/extra/model）', () => {
        const tgt = buildMigrationTarget(newPresetFixture() as any);
        expect(tgt.prompts).toHaveLength(2);
        expect(tgt.order).toHaveLength(2);
        expect(tgt.defaultSampling?.temperature).toBe(0.8);
    });

    it('listMigrationSourceNames：只列有 v3 profile 的预设，排除目标', () => {
        addPreset('Midnight', oldPresetFixture());
        addPreset('Plain', { name: 'Plain', extensions: {} });
        expect(listMigrationSourceNames('Midnight')).toEqual([]);
        expect(listMigrationSourceNames('Plain')).toEqual(['Midnight']);
    });

    it('planMigration → executeMigration 闭环：冲突解决后落盘 + 重锁基线 + 注册投影', async () => {
        const oldIdx = addPreset('Midnight', oldPresetFixture());
        const newIdx = addPreset('Midnight v2', newPresetFixture());

        const plan = planMigration(openai_settings[oldIdx] as any, openai_settings[newIdx] as any);
        // p1 content：用户 MY vs 作者 v2（base v1）→ 一个冲突
        expect(plan.summary.conflicts).toBe(1);
        expect(plan.summary.added).toBe(1); // p3
        expect(plan.summary.removed).toBe(1); // p2

        // 未解决冲突 → blocked
        const blocked = await executeMigration(openai_settings[oldIdx] as any, 'Midnight v2', newIdx, { orderStrategy: 'keep-mine' });
        expect(blocked.status).toBe('blocked');

        // 解决冲突（取我的值）后应用
        const report = plan.profileReports.find((r) => r.fieldConflicts.length > 0)!;
        const conflict = report.fieldConflicts[0];
        const applied = await executeMigration(
            openai_settings[oldIdx] as any, 'Midnight v2', newIdx,
            {
                orderStrategy: 'keep-mine',
                resolutions: [{ profileId: report.profileId, newIdentifier: conflict.newIdentifier, field: conflict.field, value: conflict.ours }],
            },
        );
        expect(applied.status).toBe('applied');

        // 目标预设 meta：profile 树全量拷贝（结构保持）+ 基线重锁 + 新基线采样
        const newMeta = readMeta(openai_settings[newIdx] as any);
        expect(newMeta.profiles.map((p: any) => p.id)).toEqual(['b1', 'd1']);
        expect((newMeta.profiles[1] as any).baseId).toBe('b1');
        expect(newMeta.defaultSnapshotLocked).toBe(true);
        expect(newMeta.defaultSnapshot.map((e: any) => e.identifier)).toEqual(['p1', 'p3']);
        expect((newMeta.profiles[0] as any).prompts.find((e: any) => e.identifier === 'p1')?.fields?.content).toBe('MY');
        // p2 被新版删除：引用保留（dangling）
        expect((newMeta.profiles[0] as any).prompts.find((e: any) => e.identifier === 'p2')).toBeDefined();

        // onMetaPersisted → sync（经 300ms 防抖异步）：新预设的 profiles 被注册为投影
        await waitFor(() => openai_setting_names['Midnight v2 - 主配置'] !== undefined
            && openai_setting_names['Midnight v2 - 战斗版'] !== undefined);
        expect(openai_setting_names['Midnight v2 - 主配置']).toBeDefined();
        expect(openai_setting_names['Midnight v2 - 战斗版']).toBeDefined();
        const projection = openai_settings[openai_setting_names['Midnight v2 - 主配置']];
        expect(readPresetMarker(projection as any)).toMatchObject({ kind: 'profile', parentKey: 'Midnight v2' });
    });

    it('追加不替换：目标已有 profiles 时保留原配置，冲突 id 重分配，基线不动', async () => {
        const oldIdx = addPreset('Midnight', oldPresetFixture());
        // 目标自带 profiles（id b1/d1 与迁移树冲突）且已锁定自己的基线
        const targetWithProfiles = newPresetFixture();
        targetWithProfiles.extensions.preset_cards.profiles = [
            { formatVersion: 3, kind: 'prompt_base', id: 'b1', name: '自带配置', prompts: [] },
            { formatVersion: 3, kind: 'prompt_delta', id: 'd1', name: '自带派生', baseId: 'b1', changes: [] },
        ];
        targetWithProfiles.extensions.preset_cards.defaultSnapshotLocked = true;
        targetWithProfiles.extensions.preset_cards.defaultSnapshot = [
            { identifier: 'p1', mounted: true, enabled: true, originalFields: { content: 'v2', role: 'system' } },
        ];
        const newIdx = addPreset('Midnight v2', targetWithProfiles);

        const plan = planMigration(openai_settings[oldIdx] as any, openai_settings[newIdx] as any);
        const report = plan.profileReports.find((r) => r.fieldConflicts.length > 0)!;
        const conflict = report.fieldConflicts[0];
        const applied = await executeMigration(
            openai_settings[oldIdx] as any, 'Midnight v2', newIdx,
            { orderStrategy: 'keep-mine', resolutions: [{ profileId: report.profileId, newIdentifier: conflict.newIdentifier, field: conflict.field, value: conflict.ours }] },
        );
        expect(applied.status).toBe('applied');

        const newMeta = readMeta(openai_settings[newIdx] as any);
        // 原有两个 profile 原样保留，迁移的两个追加在后且换了新 id（无冲突覆盖）
        expect(newMeta.profiles).toHaveLength(4);
        expect(newMeta.profiles[0].name).toBe('自带配置');
        expect(newMeta.profiles[1].name).toBe('自带派生');
        const migratedBase = newMeta.profiles[2];
        const migratedDelta = newMeta.profiles[3];
        expect(migratedBase.name).toBe('主配置');
        expect(migratedBase.id).not.toBe('b1');
        expect(migratedDelta.id).not.toBe('d1');
        expect((migratedDelta as any).baseId).toBe(migratedBase.id); // baseId 同步重映射
        // 目标已锁定的基线不被覆盖（其既有 profiles 依赖它）
        expect(newMeta.defaultSnapshot).toHaveLength(1);
        expect(newMeta.defaultSnapshotLocked).toBe(true);
    });
});
