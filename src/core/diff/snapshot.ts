// core/diff snapshot：完整 preset 快照 → 差异集（零 ST 依赖，纯函数）。
// diff 仅用于 v3 兼容导出/压缩，不参与运行时加载。
import { PROMPT_FIELD_KEYS } from '../domain/schema.js';
import type { PresetSnapshot, PromptProfileEntry, PromptStateChange } from '../domain/types.js';
import { diffPromptState, snapshotPromptState } from '../../promptState.js';

/** diff 结构对齐 v3 Delta 磁盘形状：changes = 差异集，order = 完整 mounted 顺序（可选，与父一致时省略）。 */
export interface PresetDiff {
    changes: PromptStateChange[];
    order?: string[];
}

/** 计算 child 相对 parent 的差异集（v3 兼容；顶层设置/扩展差异后续切片）。 */
export function diffSnapshot(parent: PresetSnapshot, child: PresetSnapshot): PresetDiff {
    const parentEntries = entriesWithFields(
        Array.isArray(parent.prompts) ? parent.prompts : [],
        orderEntries(parent.prompt_order),
    );
    const childEntries = entriesWithFields(
        Array.isArray(child.prompts) ? child.prompts : [],
        orderEntries(child.prompt_order),
    );
    const childUnused = childEntries.unusedIds;
    const { changes, order } = diffPromptState(childEntries.entries, parentEntries.entries, childUnused);
    return order !== undefined ? { changes, order } : { changes };
}

/** 采集挂载态 + 白名单值字段的完整 entries（snapshotPromptState 本身不采集 fields）。 */
function entriesWithFields(
    prompts: any[],
    order: { identifier: string; enabled?: boolean }[],
): { entries: PromptProfileEntry[]; unusedIds: string[] } {
    const snapshot = snapshotPromptState(prompts, order);
    const entries: PromptProfileEntry[] = snapshot.entries.map((e) => {
        const prompt = prompts.find((p) => p && p.identifier === e.identifier);
        const fields = pickFields(prompt);
        return fields ? { ...e, fields } : e;
    });
    return { entries, unusedIds: snapshot.unusedIds };
}

/** 从 prompt 取白名单值字段（content/name/role/injection_position/injection_depth）。 */
function pickFields(prompt: any): Record<string, unknown> | undefined {
    if (!prompt || typeof prompt !== 'object') return undefined;
    const fields: Record<string, unknown> = {};
    for (const key of PROMPT_FIELD_KEYS) {
        const value = prompt[key];
        if (value !== undefined) fields[key] = value;
    }
    return Object.keys(fields).length > 0 ? fields : undefined;
}

/** 提取 prompt_order 目标条目的 order 数组（v4 快照里 prompt_order 是完整数组）。 */
function orderEntries(promptOrder: unknown): { identifier: string; enabled?: boolean }[] {
    if (!Array.isArray(promptOrder)) return [];
    for (const item of promptOrder) {
        if (item && Array.isArray(item.order)) return item.order as { identifier: string; enabled?: boolean }[];
    }
    return [];
}

