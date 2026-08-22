// presetMigration：预设更新迁移的 ST 适配层（切片 4）。
// core/migration 提供纯函数（plan 分析 + apply 迁移）；本文件负责：
//   - 预设对象 ↔ MigrationSource/Target 视图（目标策略 order 解析、新基线采集）
//   - 迁移产物落盘到目标预设（替换式：全量拷贝 profile 树 + 重锁基线，设计 §4 已决策）
//   - 落盘成功后 onMetaPersisted → syncPresetRegistrations 自动把新预设上的 profiles 注册为投影
import { openai_settings } from '@sillytavern/scripts/openai';
import { readMeta, persistMetaTransaction, isPromptBaseProfile, isPromptDeltaProfile } from './meta.js';
import type { Preset } from './meta.js';
import { L } from './i18n.js';
import { findOrderList, resolvePromptOrderTarget } from './promptOrder.js';
import { captureExtra, captureModel, captureSampling } from './promptToggle.js';
import { buildMigrationPlan, type MigrationSource, type MigrationTarget, type MigrationPlan } from './core/migration/plan.js';
import {
    applyMigration,
    type MigrationApplyOptions,
    type MigrationApplyReport,
} from './core/migration/apply.js';

/** 目标策略 order 列表（global → 100001 / character → 活动角色）。 */
function targetOrderList(preset: Preset): any[] {
    const list = findOrderList(preset, resolvePromptOrderTarget());
    return Array.isArray(list?.order) ? list.order : [];
}

/** 旧预设 → 迁移源视图（含出厂基线与全部 v3 profiles——全量拷贝已决策）。 */
export function buildMigrationSource(preset: Preset): MigrationSource {
    const meta = readMeta(preset);
    return {
        prompts: Array.isArray(preset.prompts) ? preset.prompts : [],
        order: targetOrderList(preset),
        defaultSnapshot: meta.defaultSnapshot,
        profiles: (meta.profiles ?? []).filter(
            (p: any) => isPromptBaseProfile(p) || isPromptDeltaProfile(p),
        ) as MigrationSource['profiles'],
    };
}

/** 新预设 → 迁移目标视图（出厂采样/extra/模型基线由既有捕获函数采集）。 */
export function buildMigrationTarget(preset: Preset): MigrationTarget {
    return {
        prompts: Array.isArray(preset.prompts) ? preset.prompts : [],
        order: targetOrderList(preset),
        defaultSampling: captureSampling(preset) ?? undefined,
        defaultExtra: captureExtra(preset as Record<string, unknown>) ?? undefined,
        defaultModel: captureModel(preset) ?? undefined,
    };
}

/** dry-run：旧/新预设匹配与冲突清单（零写入，报告 UI 直接消费）。 */
export function planMigration(sourcePreset: Preset, targetPreset: Preset): MigrationPlan {
    return buildMigrationPlan(buildMigrationSource(sourcePreset), buildMigrationTarget(targetPreset));
}

export interface MigrationExecution {
    status: 'blocked' | 'applied' | 'persist-failed';
    unresolved?: MigrationPlan['profileReports'][number]['fieldConflicts'];
    report?: MigrationApplyReport;
}

/** 执行迁移：三方合并 + 替换式落盘到目标预设（profiles 与基线整体替换，v1 决策）。
 * 冲突解决项经 options.resolutions 传入（必须覆盖全部冲突，否则返回 blocked）。 */
export async function executeMigration(
    sourcePreset: Preset,
    targetName: string,
    targetIdx: number,
    options: MigrationApplyOptions,
): Promise<MigrationExecution> {
    const targetPreset = openai_settings[targetIdx] as Preset | undefined;
    if (!targetPreset) return { status: 'persist-failed' };
    const result = applyMigration(buildMigrationSource(sourcePreset), buildMigrationTarget(targetPreset), options);
    if (result.status === 'blocked') return { status: 'blocked', unresolved: result.unresolved };

    const ok = await persistMetaTransaction(
        readMeta(targetPreset),
        (m) => ({
            ...m,
            profiles: result.meta.profiles,
            defaultSnapshot: result.meta.defaultSnapshot,
            defaultSnapshotLocked: true,
            defaultSampling: result.meta.defaultSampling,
            defaultExtra: result.meta.defaultExtra,
            defaultModel: result.meta.defaultModel,
        }),
        targetName,
        targetIdx,
        { toastMessage: L('Failed to save preset metadata') },
    );
    if (!ok) return { status: 'persist-failed' };
    return { status: 'applied', report: result.report };
}

/** 候选来源预设：拥有 v3 profile 的预设（排除目标自身）。 */
export function listMigrationSourceNames(excludeName: string): string[] {
    const names: string[] = [];
    for (const preset of openai_settings as Preset[]) {
        if (!preset || typeof preset.name !== 'string' || preset.name === excludeName) continue;
        const meta = readMeta(preset);
        if ((meta.profiles ?? []).some((p) => isPromptBaseProfile(p) || isPromptDeltaProfile(p))) {
            names.push(preset.name);
        }
    }
    return names;
}
