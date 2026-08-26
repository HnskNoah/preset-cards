// core/migration replay：v2 逐层重放引擎（设计稿 migration-replay-editor-design.md §1）。
// 把 profile 链当 commit 序列重放到新出厂态：
//   Base 层三方 = 旧出厂态 / Base diff / 新出厂态（同 v1）；
//   Delta 层三方 = 旧父解析值 / 本层差异 / 迁移后父解析值（随上层 resolution 变化）。
// 冲突集是 resolutions 的纯函数——每次解决操作后全量重算（树小，成本可忽略）。
// 纯函数零 ST 依赖；未解决冲突的预览值暂取 ours。
import {
    matchPromptPools,
    fieldOf,
    type MigrationSource,
    type MigrationTarget,
    type PoolMatchResult,
    type PromptFieldKey,
} from './plan.js';
import { PROMPT_FIELD_KEYS, isNeverCaptureIdentifier } from '../domain/schema.js';
import type {
    PresetProfile,
    PromptBaseProfile,
    PromptDefaultSnapshotEntry,
    PromptDeltaProfile,
    PromptFields,
    PromptProfileEntry,
} from '../domain/types.js';

/** 冲突解决项：value 为最终采用的绝对值（第四选项「手动编辑」也走这里）。 */
export interface ConflictResolution {
    profileId: string;
    newIdentifier: string;
    field: PromptFieldKey;
    value: unknown;
}

export interface ReplayOptions {
    orderStrategy: 'keep-mine' | 'follow-new';
    mountNew?: 'factory' | 'unmounted';
    resolutions?: ConflictResolution[];
}

/** 逐层冲突：delta 层的 base/theirs 为父解析值（非出厂值），三值都是该层用户真实面对过的。 */
export interface LevelFieldConflict {
    profileId: string;
    profileName: string;
    kind: 'prompt_base' | 'prompt_delta';
    /** 链深度（Base = 0）。 */
    chainLevel: number;
    newIdentifier: string;
    entryName: string;
    field: PromptFieldKey;
    base: unknown;
    ours: unknown;
    theirs: unknown;
}

export interface MountStateChange {
    newIdentifier: string;
    field: 'mounted' | 'enabled';
    base: boolean;
    theirs: boolean;
}

export interface MigrationReplayReport {
    profilesMigrated: number;
    idRemaps: [string, string][];
    netZeroDropped: number;
    preservedOurs: number;
    conflictsResolved: number;
    mountFollowed: number;
    addedMounted: number;
    addedUnmounted: number;
    danglingKept: string[];
}

export interface MigrationReplayResult {
    match: PoolMatchResult;
    /** 当前 resolutions 下仍有冲突的清单（编辑器「剩余待解决」与 apply blocked 依据）。 */
    conflicts: LevelFieldConflict[];
    /** 未被 resolutions 覆盖的冲突（= conflicts，语义别名，便于阅读）。 */
    unresolved: LevelFieldConflict[];
    /** 迁移后的 profile 树预览（未解决冲突字段暂取 ours）。 */
    profiles: PresetProfile[];
    baseline: {
        defaultSnapshot: PromptDefaultSnapshotEntry[];
        defaultSampling?: MigrationTarget['defaultSampling'];
        defaultExtra?: Record<string, any>;
        defaultModel?: MigrationTarget['defaultModel'];
    };
    mountStateChanges: MountStateChange[];
    report: MigrationReplayReport;
    /** 向导报告与编辑器头部共用的摘要计数。 */
    summary: {
        matched: number;
        fingerprintRemapped: number;
        definitionChanged: number;
        added: number;
        removed: number;
        ambiguous: number;
        /** 剩余未解决冲突数。 */
        conflicts: number;
    };
}

/** 冲突解决项的键（JSON 编码，避免 identifier 含 \t 等分隔符时反解错位）。
 * 编辑器（migrationEditor）写 resolutions 与引擎查表必须走同一构造，锁步契约。 */
export function resolutionKey(profileId: string, newIdentifier: string, field: PromptFieldKey): string {
    return JSON.stringify([profileId, newIdentifier, field]);
}

/** 白名单拾取（镜像 promptCapture.capturePromptFields：跳过 undefined）。 */
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

/** 旧版（仅开关）defaultSnapshot 条目归一：缺 mounted 按「有 enabled 布尔即挂载」推断，缺 enabled 视为 false。 */
function normalizeDefaultSnapshotEntry(e: PromptDefaultSnapshotEntry): PromptDefaultSnapshotEntry {
    const mounted = typeof e.mounted === 'boolean' ? e.mounted : typeof e.enabled === 'boolean';
    return { ...e, mounted, enabled: e.enabled ?? false };
}

/** 链解析态（净零与逐层三方基准；旧树按旧 id、迁移树按新 id 键控）。 */
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

/** 条目最终态（分区 / 排序用，同 v1）。 */
interface FinalEntry {
    id: string;
    mounted: boolean;
    enabled: boolean;
    fields: PromptFields;
    hasDef: boolean;
    isNew: boolean;
}

/** 旧树逐层解析（delta 层三方的 base 来源）。 */
function oldEffOfBase(base: PromptBaseProfile, oldDefById: Map<string, Record<string, any>>): Map<string, ChainState> {
    const eff = new Map<string, ChainState>();
    for (const entry of base.prompts) {
        eff.set(entry.identifier, {
            fields: Object.keys(entry.fields ?? {}).length > 0
                ? entry.fields!
                : captureFields(oldDefById.get(entry.identifier)),
            mounted: entry.mounted,
            enabled: entry.enabled,
        });
    }
    for (const id of base.unusedIds ?? []) {
        if (eff.has(id)) continue;
        eff.set(id, { fields: captureFields(oldDefById.get(id)), mounted: false, enabled: false });
    }
    return eff;
}

function oldEffOfDelta(delta: PromptDeltaProfile, parentEff: Map<string, ChainState>): Map<string, ChainState> {
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

/** 迁移树逐层解析（delta 层三方的 theirs 来源；Base 的 fields 回退新定义）。 */
function newEffOfBase(base: PromptBaseProfile, newDefById: Map<string, Record<string, any>>): Map<string, ChainState> {
    const eff = new Map<string, ChainState>();
    for (const entry of base.prompts) {
        eff.set(entry.identifier, {
            fields: Object.keys(entry.fields ?? {}).length > 0
                ? entry.fields!
                : captureFields(newDefById.get(entry.identifier)),
            mounted: entry.mounted,
            enabled: entry.enabled,
        });
    }
    for (const id of base.unusedIds ?? []) {
        if (eff.has(id)) continue;
        eff.set(id, { fields: captureFields(newDefById.get(id)), mounted: false, enabled: false });
    }
    return eff;
}

function newEffOfDelta(delta: PromptDeltaProfile, parentEff: Map<string, ChainState>): Map<string, ChainState> {
    return oldEffOfDelta(delta, parentEff); // 形状相同：sparse 叠加
}

/** sparse map 净零：删掉与解析态等值的键（浅比较；入参 object 规避接口无索引签名收窄）。 */
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

/** 逐层重放。未解决冲突的预览值取 ours（previewMigration 语义），applyMigration 以 unresolved 判 blocked。 */
export function replayMigration(source: MigrationSource, target: MigrationTarget, options: ReplayOptions): MigrationReplayResult {
    const oldPool = source.prompts.filter((p: any) => p && typeof p.identifier === 'string').map((p: any) => ({ identifier: p.identifier as string, def: p as Record<string, any> }));
    const newPool = target.prompts.filter((p: any) => p && typeof p.identifier === 'string').map((p: any) => ({ identifier: p.identifier as string, def: p as Record<string, any> }));
    const match = matchPromptPools(oldPool, newPool);

    const oldDefById = new Map(oldPool.map((e) => [e.identifier, e.def]));
    const newDefById = new Map(newPool.map((e) => [e.identifier, e.def]));
    // v2 时代旧快照条目可能缺 mounted（{identifier, enabled}=挂载、无 enabled=unused）：
    // 先按 entriesFromDefaultSnapshot 同规则归一，否则 undefined 会让 mergeMount 把
    // 「出厂变化」误判为「用户有意保留 ours」，报告也整页误标 mount changed。
    const snapshotById = new Map((source.defaultSnapshot ?? []).map((e) => [e.identifier, normalizeDefaultSnapshotEntry(e)]));
    const oldOrderById = new Map((source.order ?? []).filter((e: any) => e && typeof e.identifier === 'string').map((e) => [e.identifier as string, e]));
    const newOrderById = new Map((target.order ?? []).filter((e: any) => e && typeof e.identifier === 'string').map((e) => [e.identifier as string, e]));

    const matchByOldId = new Map<string, MatchView>();
    for (const m of match.matches) {
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

    // 键用 JSON 编码而非分隔符拼接：identifier 是预设作者自定义串，含 \t 时
    // split 反解会错位，导致编辑器写入的 resolution 永远匹配不上（Apply 卡死）。
    const resolutions = new Map<string, unknown>();
    for (const r of options.resolutions ?? []) {
        resolutions.set(resolutionKey(r.profileId, r.newIdentifier, r.field), r.value);
    }
    const resolutionOf = (profileId: string, newId: string, field: PromptFieldKey): unknown =>
        resolutions.get(resolutionKey(profileId, newId, field));

    const conflicts: LevelFieldConflict[] = [];
    const report: MigrationReplayReport = {
        profilesMigrated: 0,
        idRemaps: [...match.idRemap.entries()],
        netZeroDropped: 0,
        preservedOurs: 0,
        conflictsResolved: 0,
        mountFollowed: 0,
        addedMounted: 0,
        addedUnmounted: 0,
        danglingKept: [],
    };

    // ---- 旧树逐层解析（delta base 侧）----
    const oldEffById = new Map<string, Map<string, ChainState>>();
    const oldLevelById = new Map<string, number>();
    {
        const pending = [...source.profiles];
        let progress = true;
        while (pending.length > 0 && progress) {
            progress = false;
            for (let i = 0; i < pending.length; i++) {
                const profile = pending[i];
                const parentReady = profile.kind === 'prompt_base'
                    || oldEffById.has(profile.baseId)
                    || !source.profiles.some((p) => p.id === profile.baseId);
                if (!parentReady) continue;
                if (profile.kind === 'prompt_base') {
                    oldEffById.set(profile.id, oldEffOfBase(profile, oldDefById));
                    oldLevelById.set(profile.id, 0);
                } else {
                    const parent = oldEffById.get(profile.baseId) ?? new Map<string, ChainState>();
                    oldEffById.set(profile.id, oldEffOfDelta(profile, parent));
                    oldLevelById.set(profile.id, (oldLevelById.get(profile.baseId) ?? 0) + 1);
                }
                pending.splice(i, 1);
                i--;
                progress = true;
            }
        }
    }

    // ---- 迁移重放（拓扑；delta 三方以父解析值为基准）----
    const migrated = new Map<string, PresetProfile>();
    const newEffById = new Map<string, Map<string, ChainState>>();
    const chainById = new Map<string, PresetProfile[]>();
    const levelById = new Map<string, number>();

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
                const next = replayBase(profile);
                migrated.set(profile.id, next);
                newEffById.set(profile.id, newEffOfBase(next, newDefById));
                chainById.set(profile.id, [next]);
                levelById.set(profile.id, 0);
            } else {
                const parentChain = chainById.get(profile.baseId) ?? [];
                const parentOldEff = oldEffById.get(profile.baseId) ?? new Map<string, ChainState>();
                const parentNewEff = newEffById.get(profile.baseId) ?? new Map<string, ChainState>();
                const level = (levelById.get(profile.baseId) ?? 0) + 1;
                const next = replayDelta(profile, parentOldEff, parentNewEff, parentChain, level);
                migrated.set(profile.id, next);
                newEffById.set(profile.id, newEffOfDelta(next, parentNewEff));
                chainById.set(profile.id, [...parentChain, next]);
                levelById.set(profile.id, level);
            }
            pending.splice(i, 1);
            i--;
            progress = true;
        }
    }

    // ---- 挂载态出厂变化报告（自动跟随项，同 v1）----
    const mountStateChanges: MountStateChange[] = [];
    for (const m of match.matches) {
        const view = matchByOldId.get(m.oldIdentifier)!;
        if (view.theirs.mounted !== view.base.mounted) {
            mountStateChanges.push({ newIdentifier: m.newIdentifier, field: 'mounted', base: view.base.mounted, theirs: view.theirs.mounted });
        }
        if (view.theirs.enabled !== view.base.enabled) {
            mountStateChanges.push({ newIdentifier: m.newIdentifier, field: 'enabled', base: view.base.enabled, theirs: view.theirs.enabled });
        }
    }

    const profiles = source.profiles.map((p) => migrated.get(p.id) ?? p);
    report.profilesMigrated = migrated.size;
    const unresolved = conflicts.filter((c) => resolutionOf(c.profileId, c.newIdentifier, c.field) === undefined);

    return {
        match,
        conflicts,
        unresolved,
        profiles,
        baseline: {
            defaultSnapshot: relockDefaultSnapshot(target),
            ...(target.defaultSampling !== undefined ? { defaultSampling: target.defaultSampling } : {}),
            ...(target.defaultExtra !== undefined ? { defaultExtra: target.defaultExtra } : {}),
            ...(target.defaultModel !== undefined ? { defaultModel: target.defaultModel } : {}),
        },
        mountStateChanges,
        report,
        summary: {
            matched: match.matches.length,
            fingerprintRemapped: match.idRemap.size,
            definitionChanged: match.matches.filter((m) => m.definitionChanged).length,
            added: match.added.length,
            removed: match.removed.length,
            ambiguous: match.ambiguous,
            conflicts: unresolved.length,
        },
    };

    // ===== Base 层：三方对出厂基线（同 v1），冲突内联检测 =====
    function replayBase(base: PromptBaseProfile): PromptBaseProfile {
        const finals: FinalEntry[] = [];
        const seen = new Set<string>();
        for (const entry of base.prompts) {
            if (seen.has(entry.identifier)) continue;
            seen.add(entry.identifier);
            finals.push(mergeBaseEntry(base, entry));
        }
        for (const id of base.unusedIds ?? []) {
            if (seen.has(id)) continue;
            seen.add(id);
            finals.push(mergeBaseEntry(base, { identifier: id, mounted: false, enabled: false }));
        }
        // profile 未引用的池条目（含新增）补齐：跟随出厂（默认）/ 一律不挂载
        const mountNew = options.mountNew ?? 'factory';
        for (const { id, factoryMounted, final } of newPoolEntries(target)) {
            if (seen.has(id)) continue;
            seen.add(id);
            if (mountNew === 'factory' && factoryMounted) {
                report.addedMounted++;
                finals.push(final);
            } else {
                report.addedUnmounted++;
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
        if (base.sampling) next.sampling = dropNetZeroKeys(base.sampling, target.defaultSampling) as PromptBaseProfile['sampling'];
        if (base.extra) next.extra = dropNetZeroKeys(base.extra, target.defaultExtra);
        if (next.sampling && Object.keys(next.sampling).length === 0) delete next.sampling;
        if (next.extra && Object.keys(next.extra).length === 0) delete next.extra;
        return next;
    }

    function mergeBaseEntry(
        base: PromptBaseProfile,
        entry: { identifier: string; mounted?: boolean; enabled?: boolean; lastActiveIndex?: number; fields?: PromptFields },
    ): FinalEntry {
        const view = matchByOldId.get(entry.identifier);
        if (!view) {
            report.danglingKept.push(entry.identifier);
            return {
                id: entry.identifier,
                mounted: entry.mounted ?? false,
                enabled: entry.enabled ?? false,
                fields: { ...(entry.fields ?? {}) },
                hasDef: false,
                isNew: false,
            };
        }
        const entryName = displayName(view.newDef, view.newId);
        const fields: PromptFields = {};
        for (const field of PROMPT_FIELD_KEYS) {
            const ours = entry.fields?.[field];
            if (ours === undefined) continue;
            const baseVal = fieldOf(snapshotById.get(entry.identifier)?.originalFields, field) ?? fieldOf(view.oldDef, field);
            const theirs = fieldOf(view.newDef, field);
            const resolution = resolutionOf(base.id, view.newId, field);
            // 真冲突才消费决策：上游重选使三方收敛后，残留的手动编辑值不得再生效
            // （设计：上层解决后才确定下层是否有冲突，无冲突的层不消费 resolutions）。
            const conflicted = ours !== baseVal && theirs !== baseVal && ours !== theirs;
            const resolvedNow = conflicted && resolution !== undefined;
            const final = resolvedNow ? resolution : ours;
            if (resolvedNow) report.conflictsResolved++;
            if (conflicted && resolution === undefined) {
                conflicts.push({ profileId: base.id, profileName: base.name, kind: 'prompt_base', chainLevel: 0, newIdentifier: view.newId, entryName, field, base: baseVal, ours, theirs });
            }
            if (final !== theirs) {
                (fields as Record<string, unknown>)[field] = final;
                if (!resolvedNow) report.preservedOurs++;
            } else {
                report.netZeroDropped++;
            }
        }
        return {
            id: view.newId,
            mounted: mergeMount(entry.mounted ?? false, view.base.mounted, view.theirs.mounted),
            enabled: mergeMount(entry.enabled ?? false, view.base.enabled, view.theirs.enabled),
            fields,
            hasDef: true,
            isNew: false,
        };
    }

    // ===== Delta 层：三方 = 旧父解析 / 本层差异 / 迁移后父解析 =====
    function replayDelta(
        delta: PromptDeltaProfile,
        parentOldEff: Map<string, ChainState>,
        parentNewEff: Map<string, ChainState>,
        parentChain: PresetProfile[],
        level: number,
    ): PromptDeltaProfile {
        const changes: PromptDeltaProfile['changes'] = [];
        for (const change of delta.changes) {
            const view = matchByOldId.get(change.identifier);
            const newId = view?.newId ?? change.identifier;
            if (!view) report.danglingKept.push(change.identifier);
            const entryName = view ? displayName(view.newDef, view.newId) : change.identifier;

            const fields: PromptFields = {};
            for (const field of PROMPT_FIELD_KEYS) {
                const ours = change.fields?.[field];
                if (ours === undefined) continue;
                const oldParentState = parentOldEff.get(change.identifier);
                const newParentState = view ? parentNewEff.get(view.newId) : undefined;
                const baseVal = oldParentState?.fields[field] ?? (view ? fieldOf(view.oldDef, field) : undefined);
                const theirs = newParentState?.fields[field] ?? (view ? fieldOf(view.newDef, field) : undefined);
                const resolution = view ? resolutionOf(delta.id, view.newId, field) : undefined;
                const conflicted = view !== undefined && ours !== baseVal && theirs !== baseVal && ours !== theirs;
                const resolvedNow = conflicted && resolution !== undefined;
                const final = resolvedNow ? resolution : ours;
                if (resolvedNow) report.conflictsResolved++;
                if (conflicted && resolution === undefined) {
                    conflicts.push({ profileId: delta.id, profileName: delta.name, kind: 'prompt_delta', chainLevel: level, newIdentifier: view.newId, entryName, field, base: baseVal, ours, theirs });
                }
                if (final !== theirs) {
                    (fields as Record<string, unknown>)[field] = final;
                    if (!resolvedNow) report.preservedOurs++;
                } else {
                    report.netZeroDropped++;
                }
            }

            const mounted = mergeChangeFlag(
                change.mounted,
                parentNewEff.get(view?.newId ?? '')?.mounted,
                view?.theirs.mounted,
            );
            const enabled = mergeChangeFlag(
                change.enabled,
                parentNewEff.get(view?.newId ?? '')?.enabled,
                view?.theirs.enabled,
            );
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
        if (delta.order) next.order = delta.order.map((id) => matchByOldId.get(id)?.newId ?? id);
        if (delta.sampling) next.sampling = dropNetZeroKeys(delta.sampling, chainEffectiveMap(parentChain, (p) => p.sampling, target.defaultSampling)) as PromptDeltaProfile['sampling'];
        if (delta.extra) next.extra = dropNetZeroKeys(delta.extra, chainEffectiveMap(parentChain, (p) => p.extra, target.defaultExtra));
        if (next.sampling && Object.keys(next.sampling).length === 0) delete next.sampling;
        if (next.extra && Object.keys(next.extra).length === 0) delete next.extra;
        return next;
    }

    /** 挂载/开关（delta 层，差异语义同字段）：布尔结构性无冲突；净零 = 与迁移后父解析一致则丢弃。
     * 注意与 Base 的全量态公式不同——delta 的 ours 是显式记录的差异，不区分「用户动没动」。 */
    function mergeChangeFlag(
        ours: boolean | undefined,
        newParentVal: boolean | undefined,
        fallbackTheirs?: boolean,
    ): boolean | undefined {
        if (ours === undefined) return undefined;
        const effectiveNew = newParentVal ?? fallbackTheirs;
        if (effectiveNew === undefined) return ours;
        return ours !== effectiveNew ? ours : undefined;
    }

    function mergeMount(ours: boolean, base: boolean, theirs: boolean): boolean {
        if (ours !== base) return ours;
        if (theirs !== base) report.mountFollowed++;
        return theirs;
    }

    function displayName(def: Record<string, any>, id: string): string {
        return typeof def.name === 'string' && def.name !== '' ? def.name : id;
    }
}

/** mounted 最终态排序：keep-mine = 原相对序 + 新条目按新出厂锚点插入（dangling 置尾）；follow-new = 新出厂序。 */
function orderMounted(finals: FinalEntry[], strategy: ReplayOptions['orderStrategy'], target: MigrationTarget): FinalEntry[] {
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
    return target.prompts
        .filter((p: any) => p && typeof p.identifier === 'string' && p.identifier && !isNeverCaptureIdentifier(p.identifier))
        .map((p: any) => {
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
