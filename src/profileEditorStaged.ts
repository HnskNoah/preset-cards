// profileEditorStaged：右栏 staged diff 的数据推导（未提交缓冲 → 展示条目）。
// 纯读取 ctx 缓冲 + profile 解析态，不写任何状态；渲染见 profileEditorRender。
import { bufferKey } from './presetBuffers.js';
import type { ProfileEntryView } from './presetList.js';
import type { EditorContext, EditorSnapshot } from './profileEditorContext.js';
import { resolveProfileMountedMap } from './profileEditorState.js';
import { resolveEditorSnapshot } from './profileEditorContext.js';

/** 右栏 staged diff 的一条记录。 */
export interface StagedItem {
    identifier: string;
    key: string;
    label: string;
    /** 主列表条目的完整展示数据（复用主列表卡片渲染）。 */
    entry?: ProfileEntryView;
    toggle?: { original: boolean; target: boolean };
    /** 挂载态变化：original 为 profile 当前挂载态，target 为目标挂载态（true=挂载 / false=卸载）。 */
    mount?: { original: boolean; target: boolean };
    /** R1：本条目存在「清除值变更」待提交（commit 时删除 profile 快照 fields）。 */
    clear?: boolean;
    /** 顺序变化（reorder）：from=打开时 index，to=当前 index。位置改变统一由 index 比较判定，进 diff。 */
    reorder?: { from: number; to: number };
}

/** 计算当前 staged diff 条目（未提交的缓冲改动：开关切换 / 值修改 / 清除）。 */
export function stagedItems(ctx: EditorContext, snapshot?: EditorSnapshot): StagedItem[] {
    const resolved = snapshot ?? resolveEditorSnapshot(ctx);
    if (!resolved) return [];
    const nameById = new Map(resolved.entries.map((e) => [e.identifier, e.name]));
    // 会话内改名：staged 面板 label 用缓冲 edited.name（否则显示旧名）
    for (const [key, session] of ctx.sessionEdits) {
        if (key.startsWith(ctx.prefix) && session.edited.name !== undefined) {
            nameById.set(key.slice(ctx.prefix.length), session.edited.name);
        }
    }
    const enabledById = new Map(resolved.entries.map((e) => [e.identifier, e.enabled]));

    const keys = new Set<string>();
    for (const k of ctx.pendingToggles.keys()) if (k.startsWith(ctx.prefix)) keys.add(k);
    for (const k of ctx.sessionEdits.keys()) if (k.startsWith(ctx.prefix)) keys.add(k);
    for (const k of ctx.pendingClears.keys()) if (k.startsWith(ctx.prefix)) keys.add(k);
    for (const k of ctx.pendingMounts.keys()) if (k.startsWith(ctx.prefix)) keys.add(k);
    // 顺序变化（reorder）：reorderedIds 由 computeReorder 用 initialOrderIndex 比较产生（专指用户拖拽），
    // 是 reorder diff 的唯一来源——不重新做 index 比较，避免挂载连带的位置漂移（卸载导致后移）被误标为 reorder。
    const reorderDiff = new Map<string, { from: number; to: number }>();
    const curIdx = new Map(resolved.entries.map((e, i) => [e.identifier, i]));
    for (const id of ctx.reorderedIds) {
        const key = bufferKey(ctx.name, id);
        // 挂载态变化的条目走 mount diff，不标 reorder（卸载/挂载连带的位置漂移非用户拖拽）
        if (ctx.pendingMounts.has(key)) continue;
        const from = ctx.initialOrderIndex.get(id);
        const to = curIdx.get(id);
        if (from !== undefined && to !== undefined && from !== to) {
            reorderDiff.set(id, { from, to });
            keys.add(key);
        }
    }

    const items: StagedItem[] = [];
    const entryById = new Map(resolved.entries.map((e) => [e.identifier, e]));
    // 挂载差异基线用 profile 解析态（与 commit diff 语义一致）；未知条目回退 initialOrder
    const profileMountedMap = resolveProfileMountedMap(resolved);
    for (const key of keys) {
        const identifier = key.slice(ctx.prefix.length);
        const entry = entryById.get(identifier);
        const item: StagedItem = { identifier, key, label: nameById.get(identifier) ?? identifier, entry };
        const rd = reorderDiff.get(identifier);
        if (rd) item.reorder = rd;
        const mountTarget = ctx.pendingMounts.get(key);
        if (mountTarget !== undefined) {
            const originalMounted = profileMountedMap.get(identifier)
                ?? ctx.initialOrder.some((o) => o.identifier === identifier);
            item.mount = { original: originalMounted, target: mountTarget };
        }
        const toggleTarget = ctx.pendingToggles.get(key);
        if (toggleTarget !== undefined) {
            item.toggle = { original: enabledById.get(identifier) ?? true, target: toggleTarget };
        }
        // F2：clear 后重新编辑（session 存在）视为清除被覆盖，不渲染 clear 项
        if (ctx.pendingClears.has(key) && !ctx.sessionEdits.has(key)) {
            item.clear = true;
        }
        items.push(item);
    }
    // 按 entries（prompt_order 展示顺序）排序，而非 identifier 字母序；未知 identifier 排最后
    const orderIdx = new Map(resolved.entries.map((e, i) => [e.identifier, i]));
    items.sort((a, b) => {
        const ia = orderIdx.get(a.identifier);
        const ib = orderIdx.get(b.identifier);
        return (ia ?? Number.MAX_SAFE_INTEGER) - (ib ?? Number.MAX_SAFE_INTEGER);
    });
    return items;
}
