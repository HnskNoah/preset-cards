// core/store EditorStore：单个 profile 编辑态（staged diff / undo / redo）。
// 零 ST 依赖、纯 reducer；commit 由 controller/adapter 消费。
import type { PresetSnapshot, PromptStateChange } from '../domain/types.js';

/** diff 结构复用 v3 Delta 形状（changes + order + topLevel）。 */
export interface EditorDiff {
    changes: PromptStateChange[];
    order?: string[];
    topLevel?: Record<string, unknown>;
}

/** 编辑器右栏 staged 面板的派生视图（P4：UI 由 store 状态投影）。 */
export interface EditorView {
    stagedChanges: PromptStateChange[];
    orderChanged: boolean;
    topLevelKeys: string[];
    dirty: boolean;
}

export function deriveEditorView(state: EditorState): EditorView {
    return {
        stagedChanges: state.staged.changes,
        orderChanged: state.staged.order !== undefined,
        topLevelKeys: Object.keys(state.staged.topLevel ?? {}),
        dirty: state.dirty,
    };
}

export interface EditorState {
    nodeId: string;
    snapshot: PresetSnapshot;
    staged: EditorDiff;
    undoStack: EditorDiff[];
    redoStack: EditorDiff[];
    dirty: boolean;
    readOnly: boolean;
}

export type EditorCommand =
    | { type: 'EDIT'; identifier: string; fields: Record<string, unknown> }
    | { type: 'TOGGLE'; identifier: string; enabled: boolean }
    | { type: 'REORDER'; order: string[] }
    | { type: 'RESET' }
    | { type: 'UNDO' }
    | { type: 'REDO' }
    | { type: 'COMMIT' };

export interface EditorStore {
    getState(): EditorState;
    dispatch(command: EditorCommand): void;
    subscribe(listener: () => void): () => void;
}

export function createEditorStore(initial: EditorState): EditorStore {
    let state = initial;
    const listeners = new Set<() => void>();

    function reducer(current: EditorState, command: EditorCommand): EditorState {
        switch (command.type) {
            case 'EDIT': {
                const changes = mergeFieldChange(current.staged.changes, command.identifier, command.fields);
                const staged: EditorDiff = { ...current.staged, changes };
                return {
                    ...current,
                    staged,
                    undoStack: [...current.undoStack, current.staged],
                    redoStack: [],
                    dirty: isDirty(staged),
                };
            }
            case 'TOGGLE': {
                const currentEnabled = findEnabled(current.snapshot, command.identifier);
                const changes = toggleEnabled(current.staged.changes, command.identifier, command.enabled, currentEnabled);
                const staged: EditorDiff = { ...current.staged, changes };
                return {
                    ...current,
                    staged,
                    undoStack: [...current.undoStack, current.staged],
                    redoStack: [],
                    dirty: isDirty(staged),
                };
            }
            case 'REORDER': {
                const staged: EditorDiff = { ...current.staged };
                if (sameOrder(command.order, current.snapshot)) delete staged.order;
                else staged.order = command.order;
                return {
                    ...current,
                    staged,
                    undoStack: [...current.undoStack, current.staged],
                    redoStack: [],
                    dirty: isDirty(staged),
                };
            }
            case 'RESET':
                return { ...current, staged: { changes: [] }, undoStack: [], redoStack: [], dirty: false };
            case 'UNDO': {
                if (current.undoStack.length === 0) return current;
                const staged = current.undoStack[current.undoStack.length - 1];
                return {
                    ...current,
                    staged,
                    undoStack: current.undoStack.slice(0, -1),
                    redoStack: [...current.redoStack, current.staged],
                    dirty: isDirty(staged),
                };
            }
            case 'REDO': {
                if (current.redoStack.length === 0) return current;
                const staged = current.redoStack[current.redoStack.length - 1];
                return {
                    ...current,
                    staged,
                    undoStack: [...current.undoStack, current.staged],
                    redoStack: current.redoStack.slice(0, -1),
                    dirty: isDirty(staged),
                };
            }
            case 'COMMIT':
                return { ...current, undoStack: [], redoStack: [], staged: { changes: [] }, dirty: false };
            default:
                return current;
        }
    }

    return {
        getState: () => state,
        dispatch: (command) => {
            const next = reducer(state, command);
            if (next === state) return;
            state = next;
            for (const listener of [...listeners]) listener();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

/** 从快照 prompt_order 读取某 identifier 的当前 enabled 真值。 */
function findEnabled(snapshot: PresetSnapshot, identifier: string): boolean {
    const orderList = Array.isArray(snapshot.prompt_order) ? snapshot.prompt_order : [];
    for (const item of orderList) {
        if (!item || !Array.isArray(item.order)) continue;
        const entry = (item.order as { identifier: string; enabled?: boolean }[]).find((o) => o.identifier === identifier);
        if (entry) return entry.enabled ?? true;
    }
    return true;
}

/** 命令顺序是否与快照当前 mounted 顺序一致（一致时净零）。 */
function sameOrder(order: string[], snapshot: PresetSnapshot): boolean {
    const current = orderEntries(snapshot);
    return order.length === current.length && order.every((id, i) => id === current[i]);
}

function orderEntries(snapshot: PresetSnapshot): string[] {
    const orderList = Array.isArray(snapshot.prompt_order) ? snapshot.prompt_order : [];
    for (const item of orderList) {
        if (!item || !Array.isArray(item.order)) continue;
        return (item.order as { identifier: string }[]).map((o) => o.identifier);
    }
    return [];
}

/** 设置 enabled 差异；与当前真值一致时净零移除。同 identifier 已 staged 的 fields 保留
 * （类型模型允许 enabled+fields 共存，applyStagedToSnapshot 按共存处理；整条丢弃会静默
 * 蒸发用户已编辑的值并让 dirty 翻回 false）。 */
function toggleEnabled(
    changes: PromptStateChange[],
    identifier: string,
    enabled: boolean,
    currentEnabled: boolean,
): PromptStateChange[] {
    const existing = changes.find((c) => c.identifier === identifier);
    const rest = changes.filter((c) => c.identifier !== identifier);
    const withFields = existing?.fields ? { identifier, fields: existing.fields } : null;
    if (enabled === currentEnabled) return withFields ? [...rest, withFields] : rest;
    return [...rest, withFields ? { ...withFields, enabled } : { identifier, enabled }];
}

/** 合并某 identifier 的值字段变更：已有 change 则合并 fields，否则新增。 */
function mergeFieldChange(
    changes: PromptStateChange[],
    identifier: string,
    fields: Record<string, unknown>,
): PromptStateChange[] {
    const existing = changes.find((c) => c.identifier === identifier);
    if (existing) {
        return changes.map((c) => (
            c.identifier === identifier ? { ...c, fields: { ...c.fields, ...fields } } : c
        ));
    }
    return [...changes, { identifier, fields }];
}

function isDirty(staged: EditorDiff): boolean {
    return staged.changes.length > 0
        || (staged.order !== undefined && staged.order.length > 0)
        || (staged.topLevel !== undefined && Object.keys(staged.topLevel).length > 0);
}

/** 把 staged 差异应用到快照，产出提交用的新快照（不改原快照）。 */
export function applyStagedToSnapshot(snapshot: PresetSnapshot, staged: EditorDiff): PresetSnapshot {
    const prompts = structuredClone(Array.isArray(snapshot.prompts) ? snapshot.prompts : []);
    const orderList = structuredClone(Array.isArray(snapshot.prompt_order) ? snapshot.prompt_order : []);
    const target = orderList[0] as { order: { identifier: string; enabled?: boolean }[] } | undefined;

    for (const change of staged.changes) {
        const prompt = prompts.find((p: any) => p && p.identifier === change.identifier);
        // v4 快照 prompts 只存 identifier + 值字段;enabled 真值在 prompt_order 层
        if (prompt && change.fields) Object.assign(prompt, change.fields);
        const orderEntry = target?.order?.find((o) => o.identifier === change.identifier);
        if (orderEntry && change.enabled !== undefined) orderEntry.enabled = change.enabled;
    }

    if (staged.order !== undefined && target) {
        const enabledMap = new Map(
            (target.order ?? []).map((o) => [o.identifier, o.enabled ?? true]),
        );
        target.order = staged.order.map((id) => ({ identifier: id, enabled: enabledMap.get(id) ?? true }));
    }

    const next: PresetSnapshot = {
        ...structuredClone(snapshot),
        prompts,
        prompt_order: orderList,
    };
    if (staged.topLevel) Object.assign(next, structuredClone(staged.topLevel));
    return next;
}
