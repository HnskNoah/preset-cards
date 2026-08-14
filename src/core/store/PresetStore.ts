// core/store PresetStore：卡片页浏览态（预设列表、搜索、批选、激活选中）。
// 零 ST 依赖、纯 reducer；UI/controller 订阅并 dispatch。
import type { PresetCardsFile, V4ProfileNode } from '../domain/types.js';

export interface PresetEntry {
    name: string;
    profileCount: number;
    isActive: boolean;
}

/** 按名称大小写不敏感过滤预设；空查询返回全部。 */
export function filterPresets(presets: PresetEntry[], query: string): PresetEntry[] {
    const q = query.trim().toLowerCase();
    if (!q) return presets;
    return presets.filter((p) => p.name.toLowerCase().includes(q));
}

/** 从 v4 文件生成预设视图条目（名称/归属 profile 数/是否激活）。 */
export function buildPresetEntries(file: PresetCardsFile, activeKey?: string): PresetEntry[] {
    const rootName = file.nodes.find((n) => n.id === 'root')?.presetSnapshot.name;
    return file.presets.map((p) => ({
        name: p.name ?? rootName ?? `preset-${p.key}`,
        profileCount: p.profileIds.length,
        isActive: p.key === activeKey,
    }));
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
    | { type: 'SET_ACTIVE'; name: string | null }
    | { type: 'TOGGLE_SELECT'; name: string }
    | { type: 'CLEAR_SELECT' };

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
            case 'TOGGLE_SELECT': {
                const selectedIds = new Set(current.selectedIds);
                if (selectedIds.has(command.name)) selectedIds.delete(command.name);
                else selectedIds.add(command.name);
                return { ...current, selectedIds };
            }
            case 'CLEAR_SELECT':
                return { ...current, selectedIds: new Set() };
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
