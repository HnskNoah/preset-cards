// core/migration apply：v2 兼容封装——逐层重放引擎见 replay.ts。
// applyMigration：有未解决冲突 → blocked（必须逐项解决完才能应用）；否则 applied（迁移产物 + 报告）。
// previewMigration：编辑器迁移模式的数据源（未解决冲突预览值取 ours，零落盘）。
import type { MigrationSource, MigrationTarget } from './plan.js';
import {
    replayMigration,
    relockDefaultSnapshot,
    type LevelFieldConflict,
    type MigrationReplayResult,
    type ReplayOptions,
} from './replay.js';
import type { PresetProfile } from '../domain/types.js';

export type {
    ConflictResolution,
    LevelFieldConflict,
    MigrationReplayResult,
    MigrationReplayReport,
    MountStateChange,
    ReplayOptions,
} from './replay.js';
export { replayMigration, relockDefaultSnapshot };

export type MigrationApplyOptions = ReplayOptions;

export interface MigratedMeta {
    defaultSnapshot: MigrationReplayResult['baseline']['defaultSnapshot'];
    defaultSampling?: MigrationTarget['defaultSampling'];
    defaultExtra?: Record<string, any>;
    defaultModel?: MigrationTarget['defaultModel'];
    profiles: PresetProfile[];
}

export type MigrationApplyResult =
    | { status: 'blocked'; unresolved: LevelFieldConflict[] }
    | {
        status: 'applied';
        meta: MigratedMeta;
        report: MigrationReplayResult['report'];
        conflicts: LevelFieldConflict[];
      };

/** 应用迁移：逐层重放；未解决冲突 → blocked。 */
export function applyMigration(
    source: MigrationSource,
    target: MigrationTarget,
    options: MigrationApplyOptions,
): MigrationApplyResult {
    const result = replayMigration(source, target, options);
    if (result.unresolved.length > 0) return { status: 'blocked', unresolved: result.unresolved };
    return {
        status: 'applied',
        meta: {
            defaultSnapshot: result.baseline.defaultSnapshot,
            ...(result.baseline.defaultSampling !== undefined ? { defaultSampling: result.baseline.defaultSampling } : {}),
            ...(result.baseline.defaultExtra !== undefined ? { defaultExtra: result.baseline.defaultExtra } : {}),
            ...(result.baseline.defaultModel !== undefined ? { defaultModel: result.baseline.defaultModel } : {}),
            profiles: result.profiles,
        },
        report: result.report,
        conflicts: result.conflicts,
    };
}

/** dry-run 分析（向导报告用）：无 resolutions 的全量预展开。 */
export function analyzeMigration(
    source: MigrationSource,
    target: MigrationTarget,
    options?: Pick<ReplayOptions, 'orderStrategy' | 'mountNew'>,
): MigrationReplayResult {
    return replayMigration(source, target, { orderStrategy: options?.orderStrategy ?? 'keep-mine', mountNew: options?.mountNew });
}

/** 编辑器迁移模式预览：带当前 resolutions 的重放结果（未解决字段预览取 ours），零落盘。 */
export function previewMigration(
    source: MigrationSource,
    target: MigrationTarget,
    options: MigrationApplyOptions,
): MigrationReplayResult {
    return replayMigration(source, target, options);
}
