// core/codec v3：v4 节点 → v3 兼容导出形状（零 ST 依赖，纯函数）。
import { PROMPT_FIELD_KEYS } from '../domain/schema.js';
import type {
    PresetCardsFile,
    PresetSnapshot,
    PromptBaseProfile,
    PromptDeltaProfile,
    PromptProfileEntry,
    V4ProfileNode,
} from '../domain/types.js';
import { snapshotPromptState } from '../../promptState.js';

/** 把 v4 节点导出为 v3 profiles（隐藏 root 不导出；根 profile → Base，非根 → Delta）。 */
export function toV3Profiles(file: PresetCardsFile): (PromptBaseProfile | PromptDeltaProfile)[] {
    const nodes = file.nodes.filter((n) => n.id !== 'root');
    return nodes.map((node) => {
        const parent = file.nodes.find((n) => n.id === node.parentId);
        const isRootProfile = node.parentId === undefined || node.parentId === 'root';
        if (isRootProfile) {
            return toV3Base(node);
        }
        return toV3Delta(node, parent?.id ?? '');
    });
}

function toV3Base(node: V4ProfileNode): PromptBaseProfile {
    const { entries, unusedIds } = entriesWithFields(node.presetSnapshot);
    return {
        formatVersion: 3,
        kind: 'prompt_base',
        id: node.id,
        name: node.name,
        prompts: entries,
        ...(unusedIds.length > 0 ? { unusedIds } : {}),
    };
}

function toV3Delta(node: V4ProfileNode, baseId: string): PromptDeltaProfile {
    const diff = (node.diff ?? { changes: [] }) as { changes: PromptStateChangeLike[]; order?: string[] };
    return {
        formatVersion: 3,
        kind: 'prompt_delta',
        id: node.id,
        name: node.name,
        baseId,
        changes: diff.changes,
        ...(diff.order !== undefined ? { order: diff.order } : {}),
    };
}

/** 从快照采集挂载态 + 白名单值字段的 v3 entries（snapshotPromptState 不采集 fields）。 */
function entriesWithFields(snapshot: PresetSnapshot): { entries: PromptProfileEntry[]; unusedIds: string[] } {
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

type PromptStateChangeLike = { identifier: string; [key: string]: unknown };
