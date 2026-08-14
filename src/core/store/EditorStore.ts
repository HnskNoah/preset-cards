// core/store EditorStore：单个 profile 编辑态（staged diff / undo / redo）。
// 零 ST 依赖、纯 reducer；commit 由 controller/adapter 消费。
import type { PresetSnapshot, PromptStateChange } from '../domain/types.js';

/** diff 结构复用 v3 Delta 形状（changes + order + topLevel）。 */
export interface EditorDiff {
    changes: PromptStateChange[];
    order?: string[];
    topLevel?: Record<string, unknown>;
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

/** 设置 enabled 差异；与当前真值一致时净零移除。 */
function toggleEnabled(
    changes: PromptStateChange[],
    identifier: string,
    enabled: boolean,
    currentEnabled: boolean,
): PromptStateChange[] {
    const rest = changes.filter((c) => c.identifier !== identifier);
    if (enabled === currentEnabled) return rest;
    return [...rest, { identifier, enabled }];
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
