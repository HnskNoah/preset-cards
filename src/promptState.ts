export interface PromptStateFields {
    content?: string;
    name?: string;
    role?: string;
    injection_position?: number;
    injection_depth?: number;
}

export interface PromptProfileEntry {
    identifier: string;
    mounted: boolean;
    enabled: boolean;
    lastActiveIndex?: number;
    fields?: PromptStateFields;
}

export interface PromptStateChange {
    identifier: string;
    mounted?: boolean;
    enabled?: boolean;
    lastActiveIndex?: number;
    fields?: PromptStateFields;
}

export interface PromptDeltaState {
    changes: PromptStateChange[];
    order?: string[];
}

export interface PromptDefinitionState {
    identifier: string;
    enabled?: boolean;
}

export interface PromptOrderState {
    identifier: string;
    enabled?: boolean;
}

export function promptOrderTarget(strategy: 'global' | 'character' | undefined, activeCharacterId?: number): number {
    return strategy === 'character' ? (activeCharacterId ?? 100001) : 100001;
}

export function snapshotPromptState(
    prompts: PromptDefinitionState[],
    order: PromptOrderState[],
): PromptProfileEntry[] {
    const promptById = new Map(prompts.map((prompt) => [prompt.identifier, prompt]));
    const entries: PromptProfileEntry[] = [];
    const mounted = new Set<string>();
    for (const orderEntry of order) {
        const prompt = promptById.get(orderEntry.identifier);
        if (!prompt || mounted.has(orderEntry.identifier)) continue;
        mounted.add(orderEntry.identifier);
        entries.push({
            identifier: orderEntry.identifier,
            mounted: true,
            enabled: orderEntry.enabled ?? prompt.enabled ?? true,
            lastActiveIndex: entries.length,
        });
    }
    for (const prompt of prompts) {
        if (mounted.has(prompt.identifier)) continue;
        entries.push({ identifier: prompt.identifier, mounted: false, enabled: prompt.enabled ?? false });
    }
    return entries;
}

export function replacementPromptOrder(
    entries: PromptProfileEntry[],
    validIdentifiers: Set<string>,
): { identifier: string; enabled: boolean }[] {
    return entries
        .filter((entry) => entry.mounted && validIdentifiers.has(entry.identifier))
        .map((entry) => ({ identifier: entry.identifier, enabled: entry.enabled }));
}

export function mountedOrder(entries: PromptProfileEntry[]): string[] {
    return entries.filter((entry) => entry.mounted).map((entry) => entry.identifier);
}

function insertMountedByHistory(order: string[], entry: PromptProfileEntry): void {
    const index = entry.lastActiveIndex;
    if (index !== undefined && Number.isInteger(index) && index >= 0 && index <= order.length) {
        order.splice(index, 0, entry.identifier);
    } else {
        order.push(entry.identifier);
    }
}

export function arrangePromptEntries(entries: PromptProfileEntry[], requestedOrder?: string[]): PromptProfileEntry[] {
    const cloned = entries.map((entry) => ({
        ...entry,
        fields: entry.fields ? { ...entry.fields } : undefined,
    }));
    const byId = new Map(cloned.map((entry) => [entry.identifier, entry]));
    const order: string[] = [];
    const seen = new Set<string>();

    if (requestedOrder) {
        for (const identifier of requestedOrder) {
            const entry = byId.get(identifier);
            if (!entry?.mounted || seen.has(identifier)) continue;
            seen.add(identifier);
            order.push(identifier);
        }
    }

    for (const entry of cloned) {
        if (!entry.mounted || seen.has(entry.identifier)) continue;
        seen.add(entry.identifier);
        if (requestedOrder) order.push(entry.identifier);
        else insertMountedByHistory(order, entry);
    }

    const mounted = order.map((identifier, index) => {
        const entry = byId.get(identifier) as PromptProfileEntry;
        return { ...entry, lastActiveIndex: index };
    });
    const unused = cloned.filter((entry) => !entry.mounted);
    return [...mounted, ...unused];
}

export function applyPromptDelta(
    parentEntries: PromptProfileEntry[],
    changes: PromptStateChange[],
    order?: string[],
): PromptProfileEntry[] {
    const entries: PromptProfileEntry[] = parentEntries.map((entry) => ({
        ...entry,
        fields: entry.fields ? { ...entry.fields } : undefined,
    }));
    const byId = new Map(entries.map((entry) => [entry.identifier, entry]));

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
        if (change.mounted !== undefined) entry.mounted = change.mounted;
        if (change.enabled !== undefined) entry.enabled = change.enabled;
        if (change.lastActiveIndex !== undefined) entry.lastActiveIndex = change.lastActiveIndex;
        if (change.fields) entry.fields = { ...entry.fields, ...change.fields };
    }

    return arrangePromptEntries(entries, order);
}

function fieldsEqual(a: PromptStateFields | undefined, b: PromptStateFields | undefined): boolean {
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    for (const key of keys) {
        if ((a as Record<string, unknown> | undefined)?.[key] !== (b as Record<string, unknown> | undefined)?.[key]) {
            return false;
        }
    }
    return true;
}

export function diffPromptState(
    entries: PromptProfileEntry[],
    parentEntries: PromptProfileEntry[],
): PromptDeltaState {
    const parentById = new Map(parentEntries.map((entry) => [entry.identifier, entry]));
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

    const currentOrder = mountedOrder(entries);
    const parentOrder = mountedOrder(parentEntries);
    const orderChanged = currentOrder.length !== parentOrder.length
        || currentOrder.some((identifier, index) => identifier !== parentOrder[index]);
    return { changes, ...(orderChanged ? { order: currentOrder } : {}) };
}
