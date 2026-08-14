// core/store PresetStore：卡片页浏览态（预设列表、搜索、批选、激活选中）。
// 零 ST 依赖、纯 reducer；UI/controller 订阅并 dispatch。
import type { V4ProfileNode } from '../domain/types.js';

export interface PresetEntry {
    name: string;
    profileCount: number;
    isActive: boolean;
}

export interface PresetStoreState {
    presets: PresetEntry[];
    search: string;
    selectedIds: Set<string>;
    activeName: string | null;
    nodes: V4ProfileNode[];
}

export type PresetStoreCommand =
    | { type: 'SET_SEARCH'; query: string }
    | { type: 'SET_ACTIVE'; name: string | null };

export interface PresetStore {
    getState(): PresetStoreState;
    dispatch(command: PresetStoreCommand): void;
    subscribe(listener: () => void): () => void;
}

export function createPresetStore(initial: PresetStoreState): PresetStore {
    let state = initial;
    const listeners = new Set<() => void>();

    function reducer(current: PresetStoreState, command: PresetStoreCommand): PresetStoreState {
        switch (command.type) {
            case 'SET_SEARCH':
                return { ...current, search: command.query };
            case 'SET_ACTIVE':
                return { ...current, activeName: command.name };
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
