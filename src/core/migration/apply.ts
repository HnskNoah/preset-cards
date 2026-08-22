// core/migration apply：迁移应用（切片 2）——dry-run 计划 → 新预设 meta。
// 纯函数零 ST 依赖。语义见 docs/plans/preset-migration-design.md：
// - 基线重锁：按新预设出厂态重建 defaultSnapshot（镜像 buildDefaultSnapshotLock 的形状）；
// - 全量拷贝 profile 树（已决策）：identifier 按指纹匹配重映射，id/baseId 保持（树内引用自洽）；
// - 三方合并：字段 final = resolution ?? ours，等于新定义 → 净零清除；
//   挂载态 final = ours≠base ? ours : theirs（布尔结构性无冲突，见 plan.ts doc）；
// - 净零重算：delta changes / sampling / extra 相对「迁移后的新父链解析态」重算；
// - 分区排序：Base prompts[] 只放 mounted（keep-mine / follow-new 两种顺序策略），
//   未挂载进 unusedIds；profile 未引用的池条目按 mountNew 策略补齐（默认跟随出厂，已决策）。
import { buildMigrationPlan, fieldOf, type MigrationSource, type MigrationTarget, type PromptFieldKey } from './plan.js';
import type { FieldConflict } from './plan.js';
import { isNeverCaptureIdentifier, PROMPT_FIELD_KEYS } from '../domain/schema.js';
import type {
    PresetProfile,
    PromptBaseProfile,
    PromptDefaultSnapshotEntry,
    PromptDeltaProfile,
    PromptFields,
    PromptProfileEntry,
} from '../domain/types.js';

/** 冲突解决项（切片 3 UI 产出）：value 为最终采用的绝对值。 */
export interface ConflictResolution {
    profileId: string;
    newIdentifier: string;
    field: PromptFieldKey;
    value: unknown;
}

export interface MigrationApplyOptions {
    /** 顺序策略：保留我的顺序（新条目按新出厂锚点插入）/ 跟随新版顺序。 */
    orderStrategy: 'keep-mine' | 'follow-new';
    /** profile 未引用的池条目挂载策略：跟随出厂（已决策默认）/ 一律不挂载。 */
    mountNew?: 'factory' | 'unmounted';
    /** 冲突解决（必须覆盖全部冲突才能应用，已决策）。 */
    resolutions?: ConflictResolution[];
}

export interface MigratedMeta {
    defaultSnapshot: PromptDefaultSnapshotEntry[];
    defaultSampling?: MigrationTarget['defaultSampling'];
    defaultExtra?: Record<string, any>;
    defaultModel?: MigrationTarget['defaultModel'];
    profiles: PresetProfile[];
}

export interface MigrationApplyReport {
    profilesMigrated: number;
    idRemaps: [string, string][];
    /** 字段覆盖被净零清除（final == 新定义/新链解析值）。 */
    netZeroDropped: number;
    /** 保留的用户字段覆盖。 */
    preservedOurs: number;
    /** 已应用的冲突解决数。 */
    conflictsResolved: number;
    /** 挂载态自动跟随新出厂的条目数（ours == base 未动）。 */
    mountFollowed: number;
    addedMounted: number;
    addedUnmounted: number;
    /** 保留的 dangling 引用（新预设无对应条目，加载时跳过）。 */
    danglingKept: string[];
}

export type MigrationApplyResult =
    | { status: 'blocked'; unresolved: FieldConflict[] }
    | { status: 'applied'; meta: MigratedMeta; report: MigrationApplyReport };

/** 白名单拾取（镜像 promptCapture.capturePromptFields：跳过 undefined，保留其余值）。 */
function captureFields(def: Record<string, any> | undefined): PromptFields {
    const out: PromptFields = {};
    if (!def) return out;
    for (const key of PROMPT_FIELD_KEYS) {
        const value = def[key];
        if (value !== undefined) out[key] = value;
    }
    return out;
}

/** 按新预设出厂态重锁基线：mounted 条目（order 序）+ unused 条目，均记 originalFields。 */
export function relockDefaultSnapshot(target: MigrationTarget): PromptDefaultSnapshotEntry[] {
    const prompts = target.prompts.filter(
        (p: any) => p && typeof p.identifier === 'string' && p.identifier && !isNeverCaptureIdentifier(p.identifier),
    );
    const order = (target.order ?? []).filter((o: any) => o && typeof o.identifier === 'string');
    const orderIdx = new Map(order.map((o: any, i: number) => [o.identifier as string, i]));
    const defById = new Map(prompts.map((p: any) => [p.identifier as string, p as Record<string, any>]));

    const out: PromptDefaultSnapshotEntry[] = [];
    const mounted = new Set<string>();
    let seq = 0;
    for (const o of order) {
        const id = o.identifier as string;
        if (mounted.has(id)) continue;
        const def = defById.get(id);
        if (!def) continue;
        mounted.add(id);
        out.push({
            identifier: id,
            mounted: true,
            enabled: o.enabled ?? def.enabled ?? true,
            lastActiveIndex: orderIdx.get(id) ?? seq,
            originalFields: captureFields(def),
        });
        seq++;
    }
    for (const p of prompts) {
        const id = p.identifier as string;
        if (mounted.has(id)) continue;
        out.push({ identifier: id, mounted: false, enabled: false, originalFields: captureFields(p) });
    }
    return out;
}

/** 条目迁移最终态（含分区 / 排序所需信息）。 */
interface FinalEntry {
    id: string;
    mounted: boolean;
    enabled: boolean;
    fields: PromptFields;
    /** 新预设池中存在定义（false = dangling，加载时跳过）。 */
    hasDef: boolean;
    /** 新增（profile 未引用）——keep-mine 排序时按新出厂锚点插入。 */
    isNew: boolean;
}

/** 链解析态（净零比较基准）。 */
interface ChainState {
    fields: PromptFields;
    mounted?: boolean;
    enabled?: boolean;
}

interface MatchView {
    newId: string;
    oldDef: Record<string, any>;
    newDef: Record<string, any>;
    base: { mounted: boolean; enabled: boolean };
    theirs: { mounted: boolean; enabled: boolean };
}

interface ApplyContext {
    matchByOldId: Map<string, MatchView>;
    newDefById: Map<string, Record<string, any>>;
    resolutionOf: (profileId: string, newId: string, field: PromptFieldKey) => unknown;
    report: MigrationApplyReport;
}

function buildApplyContext(
    source: MigrationSource,
    target: MigrationTarget,
    resolutions: ConflictResolution[] | undefined,
    conflictKeys: Set<string>,
): ApplyContext {
    const plan = buildMigrationPlan(source, target);
    const oldDefById = new Map(
        (source.prompts as any[]).filter((p) => p && typeof p.identifier === 'string').map((p) => [p.identifier as string, p as Record<string, any>]),
    );
    const newDefById = new Map(
        (target.prompts as any[]).filter((p) => p && typeof p.identifier === 'string').map((p) => [p.identifier as string, p as Record<string, any>]),
    );
    const snapshotById = new Map((source.defaultSnapshot ?? []).map((e) => [e.identifier, e]));
    const oldOrderById = new Map((source.order ?? []).filter((e: any) => e && typeof e.identifier === 'string').map((e) => [e.identifier as string, e]));
    const newOrderById = new Map((target.order ?? []).filter((e: any) => e && typeof e.identifier === 'string').map((e) => [e.identifier as string, e]));

    const matchByOldId = new Map<string, MatchView>();
    for (const m of plan.match.matches) {
        const snap = snapshotById.get(m.oldIdentifier);
        const oldOrderEntry = oldOrderById.get(m.oldIdentifier);
        const newOrderEntry = newOrderById.get(m.newIdentifier);
        matchByOldId.set(m.oldIdentifier, {
            newId: m.newIdentifier,
            oldDef: oldDefById.get(m.oldIdentifier) ?? {},
            newDef: newDefById.get(m.newIdentifier) ?? {},
            base: {
                mounted: snap ? snap.mounted : oldOrderEntry !== undefined,
                enabled: snap ? snap.enabled : oldOrderEntry?.enabled === true,
            },
            theirs: {
                mounted: newOrderEntry !== undefined,
                enabled: newOrderEntry?.enabled === true,
            },
        });
    }

    // 解决项只对「已判定为冲突的字段」生效，防误覆盖非冲突值
    const resolutionByKey = new Map<string, unknown>();
    for (const r of resolutions ?? []) {
        const key = `${r.profileId} ${r.newIdentifier} ${r.field}`;
        if (conflictKeys.has(key)) resolutionByKey.set(key, r.value);
    }

    return {
        matchByOldId,
        newDefById,
        resolutionOf: (profileId, newId, field) => resolutionByKey.get(`${profileId} ${newId} ${field}`),
        report: {
            profilesMigrated: 0,
            idRemaps: [...plan.match.idRemap.entries()],
            netZeroDropped: 0,
            preservedOurs: 0,
            conflictsResolved: 0,
            mountFollowed: 0,
            addedMounted: 0,
            addedUnmounted: 0,
            danglingKept: [],
        },
    };
}

/** 字段三方合并：final = resolution ?? ours；等于新定义 → 净零清除（返回 undefined 表示丢弃）。 */
function mergeField(
    ctx: ApplyContext,
    profileId: string,
    newId: string,
    newDef: Record<string, any>,
    field: PromptFieldKey,
    ours: unknown,
): unknown {
    const resolution = ctx.resolutionOf(profileId, newId, field);
    const final = resolution !== undefined ? resolution : ours;
    if (resolution !== undefined) ctx.report.conflictsResolved++;
    return final === fieldOf(newDef, field) ? undefined : final;
}

/** 挂载态三方合并：ours ≠ base 用 ours，否则跟随新出厂。 */
function mergeMount(ours: boolean, base: boolean, theirs: boolean, ctx: ApplyContext): boolean {
    if (ours !== base) return ours;
    if (theirs !== base) ctx.report.mountFollowed++;
    return theirs;
}

/** 既有 profile 条目 → 最终态（identifier 重映射 + 三方合并 + 净零）。dangling 引用原样保留。 */
function mergeEntry(
    ctx: ApplyContext,
    profileId: string,
    entry: { identifier: string; mounted?: boolean; enabled?: boolean; lastActiveIndex?: number; fields?: PromptFields },
): FinalEntry {
    const view = ctx.matchByOldId.get(entry.identifier);
    if (!view) {
        ctx.report.danglingKept.push(entry.identifier);
        return {
            id: entry.identifier,
            mounted: entry.mounted ?? false,
            enabled: entry.enabled ?? false,
            fields: { ...(entry.fields ?? {}) },
            hasDef: false,
            isNew: false,
        };
    }
    const fields: PromptFields = {};
    for (const field of PROMPT_FIELD_KEYS) {
        const ours = entry.fields?.[field];
        if (ours === undefined) continue;
        const final = mergeField(ctx, profileId, view.newId, view.newDef, field, ours);
        if (final !== undefined) {
            (fields as Record<string, unknown>)[field] = final;
            if (ctx.resolutionOf(profileId, view.newId, field) === undefined) ctx.report.preservedOurs++;
        } else {
            ctx.report.netZeroDropped++;
        }
    }
    return {
        id: view.newId,
        mounted: mergeMount(entry.mounted ?? false, view.base.mounted, view.theirs.mounted, ctx),
        enabled: mergeMount(entry.enabled ?? false, view.base.enabled, view.theirs.enabled, ctx),
        fields,
        hasDef: true,
        isNew: false,
    };
}

/** mounted 最终态排序：keep-mine = 原相对序 + 新条目按新出厂锚点插入（dangling 置尾）；follow-new = 新出厂序。 */
function orderMounted(finals: FinalEntry[], strategy: MigrationApplyOptions['orderStrategy'], target: MigrationTarget): FinalEntry[] {
    const mounted = finals.filter((f) => f.mounted);
    if (strategy === 'follow-new') {
        const byId = new Map(mounted.map((f) => [f.id, f]));
        const seq: FinalEntry[] = [];
        for (const o of target.order ?? []) {
            const entry = byId.get(o.identifier);
            if (entry) {
                seq.push(entry);
                byId.delete(entry.id);
            }
        }
        seq.push(...byId.values());
        return seq;
    }
    const rank = new Map((target.order ?? []).map((o: any, i: number) => [o.identifier as string, i]));
    const survivors = mounted.filter((f) => !f.isNew && rank.has(f.id));
    const added = mounted.filter((f) => f.isNew);
    const noAnchor = mounted.filter((f) => !f.isNew && !rank.has(f.id));
    const result = [...survivors];
    for (const entry of added) {
        const r = rank.get(entry.id)!;
        const idx = result.findIndex((s) => (rank.get(s.id) ?? Infinity) > r);
        if (idx === -1) result.push(entry);
        else result.splice(idx, 0, entry);
    }
    return [...result, ...noAnchor];
}

/** 新预设池条目的出厂最终态（供 base 补齐未引用条目；never-capture 排除）。 */
function newPoolEntries(target: MigrationTarget): { id: string; factoryMounted: boolean; final: FinalEntry }[] {
    const orderEntries = new Map((target.order ?? []).map((o: any) => [String(o?.identifier), o]));
    return (target.prompts as any[])
        .filter((p) => p && typeof p.identifier === 'string' && p.identifier && !isNeverCaptureIdentifier(p.identifier))
        .map((p) => {
            const id = p.identifier as string;
            const def = p as Record<string, any>;
            const orderEntry = orderEntries.get(id);
            const inOrder = orderEntry !== undefined;
            return {
                id,
                factoryMounted: inOrder,
                final: {
                    id,
                    mounted: inOrder,
                    enabled: orderEntry?.enabled ?? def.enabled ?? true,
                    fields: {},
                    hasDef: true,
                    isNew: true,
                },
            };
        });
}

/** Base 的链解析态（供子 delta 净零比较）：prompts[] 全量 + unusedIds。 */
function effectiveOfBase(base: PromptBaseProfile, ctx: ApplyContext): Map<string, ChainState> {
    const eff = new Map<string, ChainState>();
    for (const entry of base.prompts) {
        eff.set(entry.identifier, {
            fields: Object.keys(entry.fields ?? {}).length > 0
                ? entry.fields!
                : captureFields(ctx.newDefById.get(entry.identifier)),
            mounted: entry.mounted,
            enabled: entry.enabled,
        });
    }
    for (const id of base.unusedIds ?? []) {
        if (eff.has(id)) continue;
        eff.set(id, { fields: captureFields(ctx.newDefById.get(id)), mounted: false, enabled: false });
    }
    return eff;
}

/** delta 的链解析态：父链解析态叠加 sparse changes。 */
function effectiveOfDelta(delta: PromptDeltaProfile, parentEff: Map<string, ChainState>): Map<string, ChainState> {
    const eff = new Map(parentEff);
    for (const change of delta.changes) {
        const parent = eff.get(change.identifier);
        eff.set(change.identifier, {
            fields: { ...(parent?.fields ?? {}), ...(change.fields ?? {}) },
            mounted: change.mounted ?? parent?.mounted,
            enabled: change.enabled ?? parent?.enabled,
        });
    }
    return eff;
}

/** sparse map 净零：删掉与解析态等值的键（浅比较；入参用 object 规避接口无索引签名的收窄）。 */
function dropNetZeroKeys(override: object | undefined, effective: object | undefined): Record<string, unknown> {
    if (!override) return {};
    const eff = (effective ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(override)) {
        if (value !== eff[key]) out[key] = value;
    }
    return out;
}

/** 链上 sparse 解析态（root → 叶 last-writer-wins；无祖先设定时落到新出厂基线）。 */
function chainEffectiveMap(
    chain: PresetProfile[],
    pick: (p: PresetProfile) => object | undefined,
    rootBaseline: object | undefined,
): Record<string, unknown> {
    const eff: Record<string, unknown> = { ...((rootBaseline ?? {}) as Record<string, unknown>) };
    for (const p of chain) {
        Object.assign(eff, pick(p) ?? {});
    }
    return eff;
}

function migrateBaseProfile(
    base: PromptBaseProfile,
    ctx: ApplyContext,
    target: MigrationTarget,
    options: MigrationApplyOptions,
): PromptBaseProfile {
    const finals: FinalEntry[] = [];
    const seen = new Set<string>();
    for (const entry of base.prompts) {
        if (seen.has(entry.identifier)) continue;
        seen.add(entry.identifier);
        finals.push(mergeEntry(ctx, base.id, entry));
    }
    for (const id of base.unusedIds ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        // unused 无开关/字段语义：按「ours 未挂载」参与三方合并
        finals.push(mergeEntry(ctx, base.id, { identifier: id, mounted: false, enabled: false }));
    }
    // profile 未引用的池条目（含新增）补齐：跟随出厂（已决策默认）或一律不挂载
    const mountNew = options.mountNew ?? 'factory';
    for (const { id, factoryMounted, final } of newPoolEntries(target)) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (mountNew === 'factory' && factoryMounted) {
            ctx.report.addedMounted++;
            finals.push(final);
        } else {
            ctx.report.addedUnmounted++;
            finals.push({ ...final, mounted: false, enabled: false });
        }
    }

    const ordered = orderMounted(finals, options.orderStrategy, target);
    const prompts: PromptProfileEntry[] = ordered.map((f, idx) => {
        const entry: PromptProfileEntry = { identifier: f.id, mounted: true, enabled: f.enabled, lastActiveIndex: idx };
        if (Object.keys(f.fields).length > 0) entry.fields = { ...f.fields };
        return entry;
    });
    const unusedIds = finals.filter((f) => !f.mounted).map((f) => f.id);

    const next: PromptBaseProfile = { ...base, prompts };
    if (unusedIds.length > 0) next.unusedIds = unusedIds;
    else delete next.unusedIds;
    // sampling / extra 净零：相对新出厂基线
    if (base.sampling) next.sampling = dropNetZeroKeys(base.sampling, target.defaultSampling) as PromptBaseProfile['sampling'];
    if (base.extra) next.extra = dropNetZeroKeys(base.extra, target.defaultExtra);
    if (next.sampling && Object.keys(next.sampling).length === 0) delete next.sampling;
    if (next.extra && Object.keys(next.extra).length === 0) delete next.extra;
    return next;
}

function migrateDeltaProfile(
    delta: PromptDeltaProfile,
    parentEff: Map<string, ChainState>,
    parentChain: PresetProfile[],
    ctx: ApplyContext,
    target: MigrationTarget,
): PromptDeltaProfile {
    const changes: PromptDeltaProfile['changes'] = [];
    for (const change of delta.changes) {
        const view = ctx.matchByOldId.get(change.identifier);
        const newId = view?.newId ?? change.identifier;
        if (!view) ctx.report.danglingKept.push(change.identifier);
        const eff = view ? parentEff.get(view.newId) : undefined;

        const fields: PromptFields = {};
        for (const field of PROMPT_FIELD_KEYS) {
            const ours = change.fields?.[field];
            if (ours === undefined) continue;
            const final = view ? mergeField(ctx, delta.id, view.newId, view.newDef, field, ours) : ours;
            // 净零基准：迁移后父链解析值（父链无记录时回退新定义）
            const effValue = eff?.fields[field] ?? (view ? fieldOf(view.newDef, field) : undefined);
            if (final !== undefined && final !== effValue) {
                (fields as Record<string, unknown>)[field] = final;
                if (view && ctx.resolutionOf(delta.id, view.newId, field) === undefined) ctx.report.preservedOurs++;
            } else {
                ctx.report.netZeroDropped++;
            }
        }

        const mounted = change.mounted !== undefined && (!eff || change.mounted !== eff.mounted) ? change.mounted : undefined;
        const enabled = change.enabled !== undefined && (!eff || change.enabled !== eff.enabled) ? change.enabled : undefined;
        if (Object.keys(fields).length > 0 || mounted !== undefined || enabled !== undefined || change.lastActiveIndex !== undefined) {
            changes.push({
                identifier: newId,
                ...(mounted !== undefined ? { mounted } : {}),
                ...(enabled !== undefined ? { enabled } : {}),
                ...(change.lastActiveIndex !== undefined ? { lastActiveIndex: change.lastActiveIndex } : {}),
                ...(Object.keys(fields).length > 0 ? { fields } : {}),
            });
        }
    }

    const next: PromptDeltaProfile = { ...delta, changes };
    if (delta.order) next.order = delta.order.map((id) => ctx.matchByOldId.get(id)?.newId ?? id);
    // sampling / extra 净零：相对迁移后父链解析态（祖先 sparse + 新出厂基线兜底）
    if (delta.sampling) next.sampling = dropNetZeroKeys(delta.sampling, chainEffectiveMap(parentChain, (p) => p.sampling, target.defaultSampling)) as PromptDeltaProfile['sampling'];
    if (delta.extra) next.extra = dropNetZeroKeys(delta.extra, chainEffectiveMap(parentChain, (p) => p.extra, target.defaultExtra));
    if (next.sampling && Object.keys(next.sampling).length === 0) delete next.sampling;
    if (next.extra && Object.keys(next.extra).length === 0) delete next.extra;
    return next;
}

/**
 * 应用迁移：dry-run 计划 → 新预设 meta（重锁基线 + 全量拷贝重映射的 profile 树）。
 * 有未解决冲突时返回 blocked（已决策：必须逐项解决完才能应用）。
 */
export function applyMigration(
    source: MigrationSource,
    target: MigrationTarget,
    options: MigrationApplyOptions,
): MigrationApplyResult {
    const plan = buildMigrationPlan(source, target);
    const conflictKeys = new Set<string>();
    for (const report of plan.profileReports) {
        for (const c of report.fieldConflicts) {
            conflictKeys.add(`${report.profileId} ${c.newIdentifier} ${c.field}`);
        }
    }
    const resolvedKeys = new Set((options.resolutions ?? []).map((r) => `${r.profileId} ${r.newIdentifier} ${r.field}`));
    const unresolved = plan.profileReports.flatMap((report) =>
        report.fieldConflicts.map((c) => ({ c, profileId: report.profileId })),
    ).filter(({ c, profileId }) => !resolvedKeys.has(`${profileId} ${c.newIdentifier} ${c.field}`))
        .map(({ c }) => c);
    if (unresolved.length > 0) return { status: 'blocked', unresolved };

    const ctx = buildApplyContext(source, target, options.resolutions, conflictKeys);

    // 拓扑迁移：base 先行，delta 依赖父的迁移结果；父不在迁移集（外部锚点）按空链处理；成环保守原样保留
    const migrated = new Map<string, PresetProfile>();
    const effById = new Map<string, Map<string, ChainState>>();
    const chainById = new Map<string, PresetProfile[]>();
    const pending = [...source.profiles];
    let progress = true;
    while (pending.length > 0 && progress) {
        progress = false;
        for (let i = 0; i < pending.length; i++) {
            const profile = pending[i];
            const parentReady = profile.kind === 'prompt_base'
                || migrated.has(profile.baseId)
                || !source.profiles.some((p) => p.id === profile.baseId);
            if (!parentReady) continue;
            if (profile.kind === 'prompt_base') {
                const next = migrateBaseProfile(profile, ctx, target, options);
                migrated.set(profile.id, next);
                effById.set(profile.id, effectiveOfBase(next, ctx));
                chainById.set(profile.id, [next]);
            } else {
                const parentChain = chainById.get(profile.baseId) ?? [];
                const parentEff = effById.get(profile.baseId) ?? new Map<string, ChainState>();
                const next = migrateDeltaProfile(profile, parentEff, parentChain, ctx, target);
                migrated.set(profile.id, next);
                effById.set(profile.id, effectiveOfDelta(next, parentEff));
                chainById.set(profile.id, [...parentChain, next]);
            }
            pending.splice(i, 1);
            i--;
            progress = true;
        }
    }

    const profiles = source.profiles.map((p) => migrated.get(p.id) ?? p);
    ctx.report.profilesMigrated = migrated.size;

    return {
        status: 'applied',
        meta: {
            defaultSnapshot: relockDefaultSnapshot(target),
            ...(target.defaultSampling !== undefined ? { defaultSampling: target.defaultSampling } : {}),
            ...(target.defaultExtra !== undefined ? { defaultExtra: target.defaultExtra } : {}),
            ...(target.defaultModel !== undefined ? { defaultModel: target.defaultModel } : {}),
            profiles,
        },
        report: ctx.report,
    };
}
