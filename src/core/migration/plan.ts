// core/migration plan：预设更新迁移的条目池三级匹配（v2：冲突与重放引擎在 replay.ts）。
// 纯函数零 ST 依赖：identifier 精确匹配（主键）+ 内容指纹匹配（id 变内容未变 → 重映射）。
import { PROMPT_FIELD_KEYS } from '../domain/schema.js';
import type {
    PresetProfile,
    PromptDefaultSnapshotEntry,
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
    /** 旧版出厂采样/extra/模型基线，用于 profile 顶层字段三方迁移。 */
    defaultSampling?: PromptSampling;
    defaultExtra?: Record<string, any>;
    defaultModel?: PromptModel;
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
