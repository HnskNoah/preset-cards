// presetMigration：预设更新迁移的 ST 适配层（切片 4）。
// core/migration 提供纯函数（plan 分析 + apply 迁移）；本文件负责：
//   - 预设对象 ↔ MigrationSource/Target 视图（目标策略 order 解析、新基线采集）
//   - 迁移产物落盘到目标预设（替换式：全量拷贝 profile 树 + 重锁基线，设计 §4 已决策）
//   - 落盘成功后 onMetaPersisted → syncPresetRegistrations 自动把新预设上的 profiles 注册为投影
import { openai_settings } from '@sillytavern/scripts/openai';
import { readMeta, persistMetaTransaction, isPromptBaseProfile, isPromptDeltaProfile, newProfileId } from './meta.js';
import type { Preset } from './meta.js';
import { L } from './i18n.js';
import { findOrderList, resolvePromptOrderTarget } from './promptOrder.js';
import { captureExtra, captureModel, captureSampling } from './promptToggle.js';
import type { MigrationSource, MigrationTarget } from './core/migration/plan.js';
import {
    analyzeMigration,
    applyMigration,
    type LevelFieldConflict,
    type MigrationApplyOptions,
    type MigrationReplayResult,
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
/** dry-run：逐层重放分析（冲突全量预展开，零写入，向导报告与编辑器迁移模式共用）。 */
export function planMigration(sourcePreset: Preset, targetPreset: Preset): MigrationReplayResult {
    return analyzeMigration(buildMigrationSource(sourcePreset), buildMigrationTarget(targetPreset));
}

export interface MigrationExecution {
    status: 'blocked' | 'applied' | 'persist-failed';
    unresolved?: LevelFieldConflict[];
    report?: MigrationReplayResult['report'];
}

/** 与目标已有 profile 冲突的 id 重新分配，并同步重映射树内 baseId 引用（追加不替换，设计 §7）。 */
function remapCollidingIds(profiles: MigrationReplayResult['profiles'], existingIds: Set<string>): MigrationReplayResult['profiles'] {
    const reassign = new Map<string, string>();
    for (const p of profiles) {
        if (existingIds.has(String(p.id))) reassign.set(String(p.id), newProfileId());
    }
    if (reassign.size === 0) return profiles;
    return profiles.map((p) => {
        const id = reassign.get(String(p.id)) ?? String(p.id);
        if (p.kind === 'prompt_delta') {
            return { ...p, id, baseId: reassign.get(String(p.baseId)) ?? String(p.baseId) };
        }
        return { ...p, id };
    });
}

/** 执行迁移：三方合并 + 追加式落盘到目标预设。
 * - profiles 追加到目标现有 profiles 之后（不替换）；id 冲突自动重分配并重映射 baseId；
 * - 出厂基线（defaultSnapshot/sampling/extra/model）仅在目标**未锁定**基线时写入——
 *   目标已有自己的基线时不可覆盖，否则其既有 profiles 的 diff 基准会被破坏；
 * - 冲突解决项经 options.resolutions 传入（必须覆盖全部冲突，否则返回 blocked）。 */
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

    const targetMeta = readMeta(targetPreset);
    const existingIds = new Set(
        (targetMeta.profiles ?? [])
            .filter((p: any) => isPromptBaseProfile(p) || isPromptDeltaProfile(p))
            .map((p: any) => String(p.id)),
    );
    const migrated = remapCollidingIds(result.meta.profiles, existingIds);
    const keepExistingBaseline = targetMeta.defaultSnapshotLocked === true;

    const ok = await persistMetaTransaction(
        targetMeta,
        (m) => ({
            ...m,
            profiles: [...(m.profiles ?? []), ...migrated],
            ...(keepExistingBaseline ? {} : {
                defaultSnapshot: result.meta.defaultSnapshot,
                defaultSnapshotLocked: true,
                defaultSampling: result.meta.defaultSampling,
                defaultExtra: result.meta.defaultExtra,
                defaultModel: result.meta.defaultModel,
            }),
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
