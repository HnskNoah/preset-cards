// core/codec snapshotEntries：完整快照 ↔ v3 entries 的纯转换（零 ST 依赖）。
// entries 是挂载态 + 白名单值字段的 v3 prompt 条目；快照是 v4 完整 preset 状态。
import { PROMPT_FIELD_KEYS } from '../domain/schema.js';
import type { PresetSnapshot, PromptProfileEntry } from '../domain/types.js';
import { snapshotPromptState } from '../../promptState.js';

/** 从 v4 快照采集挂载态 + 白名单值字段的 v3 entries（snapshotPromptState 不采集 fields）。 */
export function entriesFromSnapshot(snapshot: PresetSnapshot): { entries: PromptProfileEntry[]; unusedIds: string[] } {
    const prompts = Array.isArray(snapshot.prompts) ? snapshot.prompts : [];
    const order = orderEntries(snapshot.prompt_order);
    const captured = snapshotPromptState(prompts, order);
    const entries: PromptProfileEntry[] = captured.entries.map((e) => {
        const prompt = prompts.find((p) => p && p.identifier === e.identifier);
        const fields = pickFields(prompt);
        return fields ? { ...e, fields } : e;
    });
    return { entries, unusedIds: captured.unusedIds };
}

/** v3 entries → v4 完整快照（prompts 展开 fields；mounted 进 order）。 */
export function entriesToSnapshot(entries: PromptProfileEntry[]): PresetSnapshot {
    const prompts = entries.map((e) => ({
        identifier: e.identifier,
        ...(e.fields ? { ...e.fields } : {}),
    }));
    const order = entries
        .filter((e) => e.mounted)
        .map((e) => ({ identifier: e.identifier, enabled: e.enabled }));
    return {
        prompts,
        prompt_order: [{ character_id: 100001, order }],
    };
}

function pickFields(prompt: any): Record<string, unknown> | undefined {
    if (!prompt || typeof prompt !== 'object') return undefined;
    const fields: Record<string, unknown> = {};
    for (const key of PROMPT_FIELD_KEYS) {
        const value = prompt[key];
        if (value !== undefined) fields[key] = value;
    }
    return Object.keys(fields).length > 0 ? fields : undefined;
}

function orderEntries(promptOrder: unknown): { identifier: string; enabled?: boolean }[] {
    if (!Array.isArray(promptOrder)) return [];
    for (const item of promptOrder) {
        if (item && Array.isArray(item.order)) return item.order as { identifier: string; enabled?: boolean }[];
    }
    return [];
}
