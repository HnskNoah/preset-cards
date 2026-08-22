import type { PromptDefaultSnapshotEntry, PromptFields, PromptProfileEntry, PromptStateChange } from './meta.js';
import { PROMPT_NEVER_CAPTURE, isNeverCaptureIdentifier } from './core/domain/schema.js';

// 不进 profile 快照的固定名 prompt 集合：实现下沉 core/domain/schema（单一来源），此处 re-export 保持既有调用点。
export { PROMPT_NEVER_CAPTURE, isNeverCaptureIdentifier };

/** 目标 prompt_order 的角色 id（策略感知）。 */
export function promptOrderTarget(strategy: 'global' | 'character' | undefined, activeCharacterId?: number): number {
    return strategy === 'character' ? (activeCharacterId ?? 100001) : 100001;
}

/**
 * 采集 prompt 定义 + 目标 order 为 v3 挂载状态快照：
 * - order 中存在的 prompt → mounted（enabled 取 order 条目，缺失回退定义层）；
 * - order 中不存在的 prompt → 仅记 identifier 于 unusedIds（unused 无开关/顺序语义，不存无意义字段）。
 * - PROMPT_NEVER_CAPTURE 中的 identifier（如 SPresetSettings）一律跳过。
 */
export function snapshotPromptState(
    prompts: { identifier: string; enabled?: boolean }[],
    order: { identifier: string; enabled?: boolean }[],
): { entries: PromptProfileEntry[]; unusedIds: string[] } {
    const promptById = new Map(prompts.map((p) => [p.identifier, p]));
    const mounted = new Set<string>();
    const entries: PromptProfileEntry[] = [];
    const orderIdx = new Map(order.map((o, i) => [o.identifier, i]));
    for (const orderEntry of order) {
        if (!orderEntry || isNeverCaptureIdentifier(orderEntry.identifier)) continue;
        const prompt = promptById.get(orderEntry.identifier);
        if (!prompt || mounted.has(orderEntry.identifier)) continue;
        mounted.add(orderEntry.identifier);
        entries.push({
            identifier: orderEntry.identifier,
            mounted: true,
            enabled: orderEntry.enabled ?? prompt.enabled ?? true,
            lastActiveIndex: orderIdx.get(orderEntry.identifier) ?? entries.length,
        });
    }
    const unusedIds = prompts
        .filter((p) => p.identifier && !isNeverCaptureIdentifier(p.identifier) && !mounted.has(p.identifier))
        .map((p) => p.identifier);
    return { entries, unusedIds };
}

/** 只取挂载中的 identifier 顺序。 */
export function mountedOrder(entries: PromptProfileEntry[]): string[] {
    return entries.filter((e) => e.mounted).map((e) => e.identifier);
}

/**
 * 组装目标 prompt_order 的条目：只保留 mounted 且在 validIdentifiers 中的 prompt。
 * unused / 后加定义不进入 order（保持未挂载）。
 */
export function replacementPromptOrder(
    entries: PromptProfileEntry[],
    validIdentifiers: Set<string>,
): { identifier: string; enabled: boolean }[] {
    return entries
        .filter((e) => e.mounted && validIdentifiers.has(e.identifier))
        .map((e) => ({ identifier: e.identifier, enabled: e.enabled }));
}

/** 按 requestedOrder 或 lastActiveIndex 历史恢复挂载顺序；unused 收尾。
 * requestedOrder 只表达顺序（不决定挂载）：不在其中的 mounted 条目按剩余相对顺序排在末尾，
 * 挂载态由 entries 自身的 mounted 决定（unmount 由 changes.mounted:false 在 applyPromptDelta 里先设好）。 */
export function arrangePromptEntries(entries: PromptProfileEntry[], requestedOrder?: string[]): PromptProfileEntry[] {
    const cloned = entries.map((e) => ({ ...e, fields: e.fields ? { ...e.fields } : undefined }));
    const byId = new Map(cloned.map((e) => [e.identifier, e]));
    const order: string[] = [];
    const seen = new Set<string>();

    if (requestedOrder) {
        for (const id of requestedOrder) {
            const entry = byId.get(id);
            if (!entry?.mounted || seen.has(id)) continue;
            seen.add(id);
            order.push(id);
        }
        // 不在 requestedOrder 的 mounted 条目：保持挂载，按原相对顺序排末尾（order 只管顺序）
        for (const entry of cloned) {
            if (!entry.mounted || seen.has(entry.identifier)) continue;
            seen.add(entry.identifier);
            order.push(entry.identifier);
        }
    } else {
        for (const entry of cloned) {
            if (!entry.mounted || seen.has(entry.identifier)) continue;
            seen.add(entry.identifier);
            insertMountedByHistory(order, entry);
        }
    }

    const mounted = order.map((id, index) => ({ ...byId.get(id) as PromptProfileEntry, lastActiveIndex: index }));
    const unused = cloned.filter((e) => !e.mounted);
    return [...mounted, ...unused];
}

function insertMountedByHistory(order: string[], entry: PromptProfileEntry): void {
    const index = entry.lastActiveIndex;
    if (index !== undefined && Number.isInteger(index) && index >= 0 && index <= order.length) {
        order.splice(index, 0, entry.identifier);
    } else {
        order.push(entry.identifier);
    }
}

/**
 * 在父链条目上叠加 delta 差异（mounted/enabled/lastActiveIndex/fields），
 * 返回重排后的完整 v3 条目（含 unused 收尾）。
 */
export function applyPromptDelta(
    parentEntries: PromptProfileEntry[],
    changes: PromptStateChange[],
    order?: string[],
): PromptProfileEntry[] {
    const entries: PromptProfileEntry[] = parentEntries.map((e) => ({ ...e, fields: e.fields ? { ...e.fields } : undefined }));
    const byId = new Map(entries.map((e) => [e.identifier, e]));

    for (const change of changes) {
        let entry = byId.get(change.identifier);
        if (!entry) {
            entry = {
                identifier: change.identifier,
                mounted: change.mounted ?? false,
                enabled: change.enabled ?? false,
            };
            entries.push(entry);
            byId.set(entry.identifier, entry);
        }
        const activatesWithoutHistory = change.mounted === true
            && !entry.mounted
            && entry.lastActiveIndex === undefined
            && change.lastActiveIndex === undefined;
        if (change.mounted !== undefined) entry.mounted = change.mounted;
        if (activatesWithoutHistory && change.enabled === undefined) entry.enabled = false;
        if (change.enabled !== undefined) entry.enabled = change.enabled;
        if (change.lastActiveIndex !== undefined) entry.lastActiveIndex = change.lastActiveIndex;
        if (change.fields) entry.fields = { ...entry.fields, ...change.fields };
    }

    return arrangePromptEntries(entries, order);
}

function fieldsEqual(a: PromptFields | undefined, b: PromptFields | undefined): boolean {
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    for (const key of keys) {
        if ((a as Record<string, unknown> | undefined)?.[key] !== (b as Record<string, unknown> | undefined)?.[key]) {
            return false;
        }
    }
    return true;
}

/** 计算 snapshot 相对父链的 delta 差异（含顺序变化）。
 * unusedIds 为当前快照的 unused 集合：对「父链 mounted 但当前 unused」的条目产出 mounted:false change，
 * 实现 delta 的 unmount（挂载态差异全走 changes，order 只表达顺序）。
 * 挂载与卸载对称：unused→mounted 由 entries 循环产出 mounted:true，mounted→unused 由本参数产出 mounted:false。 */
export function diffPromptState(
    entries: PromptProfileEntry[],
    parentEntries: PromptProfileEntry[],
    unusedIds: string[] = [],
): { changes: PromptStateChange[]; order?: string[] } {
    const parentById = new Map(parentEntries.map((e) => [e.identifier, e]));
    const changes: PromptStateChange[] = [];

    for (const entry of entries) {
        const parent = parentById.get(entry.identifier);
        if (!parent) {
            const change: PromptStateChange = {
                identifier: entry.identifier,
                mounted: entry.mounted,
                enabled: entry.enabled,
            };
            if (entry.lastActiveIndex !== undefined) change.lastActiveIndex = entry.lastActiveIndex;
            if (entry.fields && Object.keys(entry.fields).length > 0) change.fields = { ...entry.fields };
            changes.push(change);
            continue;
        }
        const change: PromptStateChange = { identifier: entry.identifier };
        if (entry.mounted !== parent.mounted) change.mounted = entry.mounted;
        if (entry.enabled !== parent.enabled) change.enabled = entry.enabled;
        if (entry.lastActiveIndex !== parent.lastActiveIndex) change.lastActiveIndex = entry.lastActiveIndex;
        if (!fieldsEqual(entry.fields, parent.fields)) change.fields = { ...(entry.fields ?? {}) };
        if (Object.keys(change).length > 1) changes.push(change);
    }

    // unmount：当前 unused 但父链 mounted → mounted:false（快照 entries 不含 unused，须显式补）
    for (const id of unusedIds) {
        const parent = parentById.get(id);
        if (parent && parent.mounted) {
            changes.push({ identifier: id, mounted: false });
        }
    }

    const currentOrder = mountedOrder(entries);
    const parentOrder = mountedOrder(parentEntries);
    const orderChanged = currentOrder.length !== parentOrder.length
        || currentOrder.some((id, i) => id !== parentOrder[i]);
    return { changes, ...(orderChanged ? { order: currentOrder } : {}) };
}

/** 从 defaultSnapshot 条目还原完整 v3 条目（unused 只保留 identifier，mounted 保留顺序）。
 * 兼容旧版 v2 快照：mounted 缺失时按「有 enabled 布尔即 mounted」推断（旧版 unused 不存 enabled）。 */
export function entriesFromDefaultSnapshot(snapshot: PromptDefaultSnapshotEntry[]): PromptProfileEntry[] {
    return snapshot.map((e) => {
        const mounted = e.mounted ?? (typeof e.enabled === 'boolean');
        return {
            identifier: e.identifier,
            mounted,
            enabled: e.enabled ?? false,
            ...(e.lastActiveIndex !== undefined ? { lastActiveIndex: e.lastActiveIndex } : {}),
            ...(e.originalFields ? { fields: { ...e.originalFields } } : {}),
        };
    });
}
