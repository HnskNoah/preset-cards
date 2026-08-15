// core/capture drift：保存捕获的 prompt 级差异（计算 + 回写），零 ST 依赖纯函数。
// 语义：原生编辑后，运行时（oai_settings）相对注册记录的漂移被捕获回 v3 profile：
//   改内容/开关 → fields/enabled 合并；调顺序 → base 重排 prompts / delta 写 order；
//   删 prompt → mounted:false（材料由适配层留父池）；新增 prompt → mounted:true 条目（定义由适配层入父池）。
import { isPromptBaseProfile, isPromptDeltaProfile, PROMPT_FIELD_KEYS } from '../domain/schema.js';
import type {
    PromptBaseProfile,
    PromptDeltaProfile,
    PromptFields,
    PromptProfileEntry,
    PromptStateChange,
} from '../domain/types.js';

export interface PromptDrift {
    /** 值字段漂移（仅白名单键，与记录不同的运行时值）。 */
    changedFields: { identifier: string; fields: PromptFields }[];
    /** 开关漂移（双方都在 order 中的条目；运行时 enabled 真值）。 */
    enabledChanges: { identifier: string; enabled: boolean }[];
    /** 运行时挂载顺序；与记录一致时为 undefined。 */
    order: string[] | undefined;
    /** 记录池有、运行时池无的 identifier（池删除 → unmount + 材料留池）。 */
    deleted: string[];
    /** 双方池都有、但记录 order 有而运行时 order 无的 identifier（ST 摘除/detach → unmount）。 */
    unmounted: string[];
    /** 记录 order 无而运行时 order 有的 identifier（重新挂载 → mounted:true）。 */
    remounted: { identifier: string; enabled: boolean }[];
    /** 运行时新增（记录无）的 identifier 与定义（→ 父池 + 挂载条目）。 */
    added: { identifier: string; definition: Record<string, any> }[];
}

export function isEmptyPromptDrift(drift: PromptDrift): boolean {
    return drift.changedFields.length === 0
        && drift.enabledChanges.length === 0
        && drift.order === undefined
        && drift.deleted.length === 0
        && drift.unmounted.length === 0
        && drift.remounted.length === 0
        && drift.added.length === 0;
}

/** 提取 prompt 定义中的白名单字段。 */
export function pickPromptFields(definition: Record<string, any> | undefined): PromptFields {
    const fields: PromptFields = {};
    if (!definition || typeof definition !== 'object') return fields;
    for (const key of PROMPT_FIELD_KEYS) {
        if (definition[key] !== undefined) (fields as Record<string, unknown>)[key] = definition[key];
    }
    return fields;
}

function promptMap(prompts: any[] | undefined): Map<string, any> {
    const map = new Map<string, any>();
    if (!Array.isArray(prompts)) return map;
    for (const p of prompts) {
        if (p && typeof p.identifier === 'string') map.set(p.identifier, p);
    }
    return map;
}

/** 首个 prompt_order 列表的 identifier → enabled 真值（缺省 true）。 */
function enabledMap(orderList: any[] | undefined): Map<string, boolean> {
    const map = new Map<string, boolean>();
    if (!Array.isArray(orderList)) return map;
    for (const item of orderList) {
        if (!item || !Array.isArray(item.order)) continue;
        for (const o of item.order as { identifier: string; enabled?: boolean }[]) {
            if (o && typeof o.identifier === 'string') map.set(o.identifier, o.enabled ?? true);
        }
        break; // 只取目标列表（首个）
    }
    return map;
}

/** 首个 prompt_order 列表的挂载 identifier 顺序。 */
function mountedOrder(orderList: any[] | undefined): string[] {
    if (!Array.isArray(orderList)) return [];
    for (const item of orderList) {
        if (!item || !Array.isArray(item.order)) continue;
        return (item.order as { identifier: string }[])
            .filter((o) => o && typeof o.identifier === 'string')
            .map((o) => o.identifier);
    }
    return [];
}

function sameOrder(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((id, i) => id === b[i]);
}

function diffFields(recordDef: any, runtimeDef: any): PromptFields | undefined {
    const fields: PromptFields = {};
    let changed = false;
    for (const key of PROMPT_FIELD_KEYS) {
        const rv = runtimeDef?.[key];
        const cv = recordDef?.[key];
        if (rv !== cv && rv !== undefined) {
            (fields as Record<string, unknown>)[key] = rv;
            changed = true;
        }
    }
    return changed ? fields : undefined;
}

/** 计算运行时 vs 注册记录 的 prompt 级漂移。
 * 关键语义：ST 的「Remove」= detach（从 order 摘除、池保留）→ 识别为 unmounted；
 * 池删除（handleDeletePrompt）→ deleted；重新挂载（append）→ remounted。 */
export function computePromptDrift(
    runtime: { prompts?: any[]; prompt_order?: any[] },
    record: { prompts?: any[]; prompt_order?: any[] },
): PromptDrift {
    const rt = promptMap(runtime.prompts);
    const rc = promptMap(record.prompts);
    const rtEnabled = enabledMap(runtime.prompt_order);
    const rcEnabled = enabledMap(record.prompt_order);
    const rtOrder = mountedOrder(runtime.prompt_order);
    const rcOrder = mountedOrder(record.prompt_order);
    const rtOrderSet = new Set(rtOrder);
    const rcOrderSet = new Set(rcOrder);

    const changedFields: PromptDrift['changedFields'] = [];
    const enabledChanges: PromptDrift['enabledChanges'] = [];
    const deleted: string[] = [];
    const unmounted: string[] = [];
    const remounted: PromptDrift['remounted'] = [];
    for (const [id, recordDef] of rc) {
        const runtimeDef = rt.get(id);
        if (!runtimeDef) {
            deleted.push(id);
            continue;
        }
        const inRtOrder = rtOrderSet.has(id);
        const inRcOrder = rcOrderSet.has(id);
        if (inRcOrder && !inRtOrder) {
            // ST detach：从 order 摘除（池保留）→ unmount，不再做 enabled 判定（避免默认 true 误写）
            unmounted.push(id);
            continue;
        }
        if (!inRcOrder && inRtOrder) {
            remounted.push({ identifier: id, enabled: rtEnabled.get(id) ?? true });
            continue;
        }
        const fields = diffFields(recordDef, runtimeDef);
        if (fields) changedFields.push({ identifier: id, fields });
        if (inRtOrder && inRcOrder) {
            const re = rtEnabled.get(id) ?? true;
            const ce = rcEnabled.get(id) ?? true;
            if (re !== ce) enabledChanges.push({ identifier: id, enabled: re });
        }
    }
    const added: PromptDrift['added'] = [];
    for (const [id, def] of rt) {
        if (!rc.has(id)) added.push({ identifier: id, definition: structuredClone(def) });
    }
    const order = sameOrder(rtOrder, rcOrder) ? undefined : rtOrder;
    return { changedFields, enabledChanges, order, deleted, unmounted, remounted, added };
}

/** 把漂移回写进 v3 profile（base/delta），返回新 profile（不改原对象）。 */
export function applyPromptDriftToProfile(
    profile: PromptBaseProfile | PromptDeltaProfile,
    drift: PromptDrift,
): PromptBaseProfile | PromptDeltaProfile {
    const next = structuredClone(profile) as PromptBaseProfile | PromptDeltaProfile;
    if (isPromptBaseProfile(next)) {
        const prompts: PromptProfileEntry[] = next.prompts.map(
            (e): PromptProfileEntry => ({ ...e, fields: e.fields ? { ...e.fields } : undefined }),
        );
        const byId = new Map(prompts.map((e) => [e.identifier, e]));
        for (const c of drift.changedFields) {
            const e = byId.get(c.identifier);
            if (e) e.fields = { ...e.fields, ...c.fields };
        }
        for (const c of drift.enabledChanges) {
            const e = byId.get(c.identifier);
            if (e) e.enabled = c.enabled;
        }
        for (const id of [...drift.deleted, ...drift.unmounted]) {
            const e = byId.get(id);
            if (e) {
                // 删除/摘除 = unmount + 禁用：渲染层开关读 enabled，仅 mounted:false 会仍显示为开
                e.mounted = false;
                e.enabled = false;
            }
        }
        for (const r of drift.remounted) {
            const e = byId.get(r.identifier);
            if (e) {
                e.mounted = true;
                e.enabled = r.enabled;
            }
        }
        for (const a of drift.added) {
            if (!byId.has(a.identifier)) {
                const entry: PromptProfileEntry = {
                    identifier: a.identifier,
                    mounted: true,
                    enabled: true,
                    fields: pickPromptFields(a.definition),
                };
                prompts.push(entry);
                byId.set(a.identifier, entry);
            }
        }
        // base 顺序 = prompts 数组挂载序：mounted 按运行时顺序重排，unmounted 原序收尾
        if (drift.order) {
            const ordered: PromptProfileEntry[] = [];
            for (const id of drift.order) {
                const entry = byId.get(id);
                if (entry?.mounted) ordered.push(entry);
            }
            const seen = new Set(ordered.map((e) => e.identifier));
            const rest = prompts.filter((e) => !seen.has(e.identifier));
            next.prompts = [...ordered, ...rest];
        } else {
            next.prompts = prompts;
        }
        const detachedIds = [...drift.deleted, ...drift.unmounted];
        if (detachedIds.length > 0) {
            const existing = new Set(Array.isArray(next.unusedIds) ? next.unusedIds : []);
            for (const id of detachedIds) {
                if (byId.has(id) && !existing.has(id)) existing.add(id);
            }
            next.unusedIds = [...existing];
        }
        if (drift.remounted.length > 0) {
            const remountedIds = new Set(drift.remounted.map((r) => r.identifier));
            if (Array.isArray(next.unusedIds)) {
                next.unusedIds = next.unusedIds.filter((id) => !remountedIds.has(id));
            }
        }
        return next;
    }

    if (isPromptDeltaProfile(next)) {
        const changes: PromptStateChange[] = next.changes.map(
            (c): PromptStateChange => ({ ...c, fields: c.fields ? { ...c.fields } : undefined }),
        );
        const byId = new Map(changes.map((c) => [c.identifier, c]));
        const upsert = (change: PromptStateChange) => {
            const existing = byId.get(change.identifier);
            if (existing) {
                existing.enabled = change.enabled ?? existing.enabled;
                existing.mounted = change.mounted ?? existing.mounted;
                if (change.fields) existing.fields = { ...existing.fields, ...change.fields };
            } else {
                changes.push(change);
                byId.set(change.identifier, change);
            }
        };
        for (const c of drift.changedFields) upsert({ identifier: c.identifier, fields: c.fields });
        for (const c of drift.enabledChanges) upsert({ identifier: c.identifier, enabled: c.enabled });
        // 删除/摘除 = unmount + 禁用（渲染层开关读 enabled）
        for (const id of [...drift.deleted, ...drift.unmounted]) {
            upsert({ identifier: id, mounted: false, enabled: false });
        }
        for (const r of drift.remounted) upsert({ identifier: r.identifier, mounted: true, enabled: r.enabled });
        for (const a of drift.added) upsert({
            identifier: a.identifier,
            mounted: true,
            enabled: true,
            fields: pickPromptFields(a.definition),
        });
        next.changes = changes;
        if (drift.order) next.order = [...drift.order];
        return next;
    }

    return next;
}
