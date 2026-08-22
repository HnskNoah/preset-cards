// core/migration plan：预设更新迁移 dry-run 分析（切片 1）——旧预设 profile 树 rebase 到新版预设。
// 纯函数零 ST 依赖：输入旧/新预设最小视图（prompts 池 + 目标 order + 旧 meta 基线），
// 产出三级匹配报告与逐 profile 冲突清单；不写任何数据（应用在切片 2）。
// 三方合并语义见 docs/plans/preset-migration-design.md §2：base = defaultSnapshot，ours = profile，theirs = 新出厂态。
import { PROMPT_FIELD_KEYS } from '../domain/schema.js';
import type {
    PresetProfile,
    PromptDefaultSnapshotEntry,
    PromptFields,
    PromptModel,
    PromptSampling,
} from '../domain/types.js';

export type PromptFieldKey = (typeof PROMPT_FIELD_KEYS)[number];

/** prompt 定义池条目：identifier + 原始定义对象。 */
export interface PromptPoolEntry {
    identifier: string;
    def: Record<string, any>;
}

/** 迁移源（旧预设）最小视图：池 + 目标 order + 出厂基线 + 待迁移 profile 树（全量）。 */
export interface MigrationSource {
    prompts: any[];
    /** 目标策略 order 列表（适配层已解析；元素含 identifier/enabled）。 */
    order: any[];
    defaultSnapshot?: PromptDefaultSnapshotEntry[];
    profiles: PresetProfile[];
}

/** 迁移目标（新预设）最小视图。采样/extra/模型出厂基线由适配层用既有捕获代码采集后传入。 */
export interface MigrationTarget {
    prompts: any[];
    order: any[];
    defaultSampling?: PromptSampling;
    defaultExtra?: Record<string, any>;
    defaultModel?: PromptModel;
}

/** 一对匹配条目：method 标识匹配级别，changedFields 为白名单内发生定义变化的字段。 */
export interface PoolMatch {
    oldIdentifier: string;
    newIdentifier: string;
    method: 'id' | 'fingerprint';
    definitionChanged: boolean;
    changedFields: PromptFieldKey[];
}

export interface PoolMatchResult {
    matches: PoolMatch[];
    /** 新预设独有：按「跟随出厂」策略处理（已决策）。 */
    added: PromptPoolEntry[];
    /** 旧预设独有：profile 引用保留不动，加载时自动跳过缺失（设计 §5）。 */
    removed: PromptPoolEntry[];
    /** 需要 id 重映射的 old→new 表（仅 fingerprint 匹配；id 匹配恒等不在表内）。 */
    idRemap: Map<string, string>;
    /** 指纹在某一侧不唯一、未自动匹配的条目数（v1 计入 added/removed，切片 3 可手动配对）。 */
    ambiguous: number;
}

/** 字段级冲突：双方都改且值不同。base/ours/theirs 语义见设计 §2。 */
export interface FieldConflict {
    newIdentifier: string;
    entryName: string;
    field: PromptFieldKey;
    base: unknown;
    ours: unknown;
    theirs: unknown;
}

export interface ProfileMigrationReport {
    profileId: string;
    profileName: string;
    kind: 'prompt_base' | 'prompt_delta';
    fieldConflicts: FieldConflict[];
    /** profile 引用、但新预设无对应条目的旧 identifier（保留引用，仅提示）。 */
    danglingReferences: string[];
    /** delta 是否带显式 order（影响全局顺序策略提示）。 */
    hasExplicitOrder: boolean;
}

/** 出厂挂载态变化（theirs 侧、非冲突）：迁移时自动跟随，dry-run 报告用。 */
export interface MountStateChange {
    newIdentifier: string;
    field: 'mounted' | 'enabled';
    base: boolean;
    theirs: boolean;
}

export interface MigrationPlan {
    match: PoolMatchResult;
    mountStateChanges: MountStateChange[];
    profileReports: ProfileMigrationReport[];
    summary: {
        matched: number;
        fingerprintRemapped: number;
        definitionChanged: number;
        added: number;
        removed: number;
        ambiguous: number;
        conflicts: number;
    };
}

/** 白名单字段取值：null 归一为 undefined（JSON 里 absent 与 null 语义等价处理）。 */
export function fieldOf(def: Record<string, any> | undefined, key: PromptFieldKey): unknown {
    const value = def?.[key];
    return value === null ? undefined : value;
}

/** prompt 定义内容指纹：仅白名单值字段，按固定键序写入保证 JSON.stringify 稳定。 */
function promptDefinitionFingerprint(def: Record<string, any>): string {
    const picked: Record<string, unknown> = {};
    for (const key of PROMPT_FIELD_KEYS) {
        const value = fieldOf(def, key);
        if (value !== undefined) picked[key] = value;
    }
    return JSON.stringify(picked);
}

function toPool(prompts: any[]): PromptPoolEntry[] {
    return prompts.filter(
        (p): p is { identifier: string } => p && typeof p.identifier === 'string',
    ).map((p) => ({ identifier: p.identifier, def: p as Record<string, any> }));
}

function diffMatch(oldEntry: PromptPoolEntry, newEntry: PromptPoolEntry, method: 'id' | 'fingerprint'): PoolMatch {
    const changedFields = PROMPT_FIELD_KEYS.filter(
        (key) => fieldOf(oldEntry.def, key) !== fieldOf(newEntry.def, key),
    );
    return {
        oldIdentifier: oldEntry.identifier,
        newIdentifier: newEntry.identifier,
        method,
        definitionChanged: changedFields.length > 0,
        changedFields,
    };
}

/**
 * 三级匹配：① identifier 精确（主键，内容不同视为「作者编辑」仍同条目）；
 * ② 内容指纹（id 变内容未变 → 重映射；指纹须两侧各自唯一，否则计 ambiguous）。
 */
export function matchPromptPools(oldPool: PromptPoolEntry[], newPool: PromptPoolEntry[]): PoolMatchResult {
    const oldById = new Map(oldPool.map((e) => [e.identifier, e]));
    const newById = new Map(newPool.map((e) => [e.identifier, e]));

    const matches: PoolMatch[] = [];
    const matchedOld = new Set<string>();
    const matchedNew = new Set<string>();

    for (const [id, newEntry] of newById) {
        const oldEntry = oldById.get(id);
        if (!oldEntry) continue;
        matchedOld.add(id);
        matchedNew.add(id);
        matches.push(diffMatch(oldEntry, newEntry, 'id'));
    }

    const fpOld = new Map<string, PromptPoolEntry[]>();
    for (const entry of oldPool) {
        if (matchedOld.has(entry.identifier)) continue;
        const fp = promptDefinitionFingerprint(entry.def);
        const bucket = fpOld.get(fp) ?? [];
        bucket.push(entry);
        fpOld.set(fp, bucket);
    }
    const fpNew = new Map<string, PromptPoolEntry[]>();
    for (const entry of newPool) {
        if (matchedNew.has(entry.identifier)) continue;
        const fp = promptDefinitionFingerprint(entry.def);
        const bucket = fpNew.get(fp) ?? [];
        bucket.push(entry);
        fpNew.set(fp, bucket);
    }

    const idRemap = new Map<string, string>();
    let ambiguous = 0;
    for (const [fp, newEntries] of fpNew) {
        const oldEntries = fpOld.get(fp);
        if (!oldEntries || oldEntries.length !== 1 || newEntries.length !== 1) {
            ambiguous += newEntries.length;
            continue;
        }
        const oldEntry = oldEntries[0];
        const newEntry = newEntries[0];
        matchedOld.add(oldEntry.identifier);
        matchedNew.add(newEntry.identifier);
        matches.push(diffMatch(oldEntry, newEntry, 'fingerprint'));
        idRemap.set(oldEntry.identifier, newEntry.identifier);
    }

    return {
        matches,
        added: newPool.filter((e) => !matchedNew.has(e.identifier)),
        removed: oldPool.filter((e) => !matchedOld.has(e.identifier)),
        idRemap,
        ambiguous,
    };
}

/** 出厂挂载态（base 侧）：优先 defaultSnapshot，缺省回退旧目标 order 推导。 */
function baseMountOf(
    snapshotById: Map<string, PromptDefaultSnapshotEntry>,
    oldOrderById: Map<string, any>,
    oldIdentifier: string,
): { mounted: boolean; enabled: boolean } {
    const snap = snapshotById.get(oldIdentifier);
    if (snap) return { mounted: snap.mounted, enabled: snap.enabled };
    const orderEntry = oldOrderById.get(oldIdentifier);
    return { mounted: orderEntry !== undefined, enabled: orderEntry?.enabled === true };
}

/** 新出厂挂载态（theirs 侧）：由新目标 order 推导。 */
function theirsMountOf(newOrderById: Map<string, any>, newIdentifier: string): { mounted: boolean; enabled: boolean } {
    const orderEntry = newOrderById.get(newIdentifier);
    return { mounted: orderEntry !== undefined, enabled: orderEntry?.enabled === true };
}

interface ProfileEntryView {
    identifier: string;
    mounted?: boolean;
    enabled?: boolean;
    fields?: PromptFields;
}

/** Base 的 prompts[] 视为全量条目（mounted/enabled 必有）；Delta 的 changes[] 为 sparse 差异。 */
function profileEntries(profile: PresetProfile): ProfileEntryView[] {
    if (profile.kind === 'prompt_base') return profile.prompts;
    return profile.changes;
}

/** profile 全部引用过的 identifier（含 unusedIds / delta order），用于 dangling 检测。 */
function profileReferences(profile: PresetProfile): string[] {
    const refs = profileEntries(profile).map((e) => e.identifier);
    if (profile.kind === 'prompt_base' && profile.unusedIds) refs.push(...profile.unusedIds);
    if (profile.kind === 'prompt_delta' && profile.order) refs.push(...profile.order);
    return refs;
}

/**
 * dry-run 迁移分析：匹配旧/新条目池，按三方合并语义产出每 profile 的冲突清单与汇总计数。
 * 冲突判据（标准三方）：ours ≠ base && theirs ≠ base && ours ≠ theirs。
 * 推论：mounted/enabled 为二值域，双方都改时必然收敛同值——布尔三方合并**结构性无冲突**，
 * 只有白名单值字段（字符串/数字五值域）可能撞车，故冲突类型只有 FieldConflict。
 */
export function buildMigrationPlan(source: MigrationSource, target: MigrationTarget): MigrationPlan {
    const oldPool = toPool(source.prompts);
    const newPool = toPool(target.prompts);
    const match = matchPromptPools(oldPool, newPool);

    const snapshotById = new Map(
        (source.defaultSnapshot ?? []).map((e) => [e.identifier, e]),
    );
    const oldOrderById = new Map(
        (source.order ?? []).filter((e) => e && typeof e.identifier === 'string').map((e) => [e.identifier, e]),
    );
    const newOrderById = new Map(
        (target.order ?? []).filter((e) => e && typeof e.identifier === 'string').map((e) => [e.identifier, e]),
    );

    // 匹配条目的视图：oldId → {newId, oldDef, newDef, baseMount, theirsMount}
    interface MatchView {
        newId: string;
        oldDef: Record<string, any>;
        newDef: Record<string, any>;
        base: { mounted: boolean; enabled: boolean };
        theirs: { mounted: boolean; enabled: boolean };
    }
    const oldDefById = new Map(oldPool.map((e) => [e.identifier, e.def]));
    const newDefById = new Map(newPool.map((e) => [e.identifier, e.def]));
    const matchByOldId = new Map<string, MatchView>();
    for (const m of match.matches) {
        matchByOldId.set(m.oldIdentifier, {
            newId: m.newIdentifier,
            oldDef: oldDefById.get(m.oldIdentifier) ?? {},
            newDef: newDefById.get(m.newIdentifier) ?? {},
            base: baseMountOf(snapshotById, oldOrderById, m.oldIdentifier),
            theirs: theirsMountOf(newOrderById, m.newIdentifier),
        });
    }

    // 出厂挂载态变化（自动跟随项）
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

    // 逐 profile 冲突清单（布尔挂载态结构性无冲突，见函数 doc）
    const matchedOldIds = new Set(match.matches.map((m) => m.oldIdentifier));
    const profileReports: ProfileMigrationReport[] = source.profiles.map((profile) => {
        const fieldConflicts: FieldConflict[] = [];
        const danglingReferences: string[] = [];

        for (const entry of profileEntries(profile)) {
            const view = matchByOldId.get(entry.identifier);
            if (!view) continue; // dangling 在下方统一收集
            const entryName = typeof view.newDef.name === 'string' && view.newDef.name !== ''
                ? view.newDef.name
                : view.newId;

            for (const field of PROMPT_FIELD_KEYS) {
                const ours = entry.fields?.[field];
                if (ours === undefined) continue; // 未改 → 自动跟随 theirs，无冲突
                const base = fieldOf(snapshotById.get(entry.identifier)?.originalFields, field)
                    ?? fieldOf(view.oldDef, field);
                const theirs = fieldOf(view.newDef, field);
                if (ours !== base && theirs !== base && ours !== theirs) {
                    fieldConflicts.push({ newIdentifier: view.newId, entryName, field, base, ours, theirs });
                }
            }
        }

        for (const ref of profileReferences(profile)) {
            if (!matchedOldIds.has(ref)) danglingReferences.push(ref);
        }

        return {
            profileId: profile.id,
            profileName: profile.name,
            kind: profile.kind,
            fieldConflicts,
            danglingReferences: [...new Set(danglingReferences)],
            hasExplicitOrder: profile.kind === 'prompt_delta' && profile.order !== undefined,
        };
    });

    const conflicts = profileReports.reduce((sum, r) => sum + r.fieldConflicts.length, 0);

    return {
        match,
        mountStateChanges,
        profileReports,
        summary: {
            matched: match.matches.length,
            fingerprintRemapped: match.idRemap.size,
            definitionChanged: match.matches.filter((m) => m.definitionChanged).length,
            added: match.added.length,
            removed: match.removed.length,
            ambiguous: match.ambiguous,
            conflicts,
        },
    };
}
