import { promptManager } from '@sillytavern/scripts/openai';
import { isPromptBaseProfile, isPromptDeltaProfile } from './meta.js';
import type { Preset, PromptBaseProfile, PromptDeltaProfile, PromptProfileEntry } from './meta.js';
import { applyPromptDelta, arrangePromptEntries, mountedOrder, promptOrderTarget, replacementPromptOrder } from './promptState.js';

/** 在 preset.prompt_order 中查找指定 character_id 的条目。 */
export function findOrderList(preset: Preset, characterId: number | string): any {
    if (!Array.isArray(preset.prompt_order)) return undefined;
    return preset.prompt_order.find((x: any) => x && String(x.character_id) === String(characterId));
}

/** 读取 prompt_order 的写入目标角色 id（策略感知）。 */
export function resolvePromptOrderTarget(): number {
    return promptOrderTarget(
        promptManager?.configuration?.promptOrder?.strategy,
        promptManager?.activeCharacter?.id,
    );
}

/** 同步 preset.prompt_order 中目标策略条目（global → 100001 / character → 活动角色 id）的开关。
 * 对应条目的 order 数组仅按 identifier 更新已存在条目的 enabled；缺失条目保持 unused，不自动挂载。 */
export function syncPromptOrder(
    preset: Preset,
    entries: { identifier: string; enabled: boolean }[],
): void {
    const list = findOrderList(preset, resolvePromptOrderTarget());
    if (!Array.isArray(list?.order)) return;

    for (const entry of entries) {
        const existing = list.order.find((o: any) => o?.identifier === entry.identifier);
        if (existing) {
            existing.enabled = entry.enabled;
        }
    }
}

/**
 * 整条替换目标 prompt_order 为 resolved 状态中的 mounted 条目（v3 核心应用）。
 * 与 syncPromptOrder（只更新已存在 enabled）不同：此函数重建整个 order 列表，
 * 实现「mounted 的挂载、unused 的不挂载」的精确还原。
 */
export function replaceTargetPromptOrder(
    preset: Preset,
    entries: PromptProfileEntry[],
    characterId: number | string = resolvePromptOrderTarget(),
): void {
    if (!Array.isArray(preset.prompt_order)) preset.prompt_order = [];
    let list = findOrderList(preset, characterId);
    if (!list) {
        list = { character_id: characterId, order: [] };
        preset.prompt_order.push(list);
    }
    const existing = new Map<string, any>(
        (Array.isArray(list.order) ? list.order : [])
            .filter((entry: any) => entry && typeof entry.identifier === 'string')
            .map((entry: any) => [entry.identifier, entry]),
    );
    const validIds = new Set(
        (Array.isArray(preset.prompts) ? preset.prompts : [])
            .filter((prompt: any) => prompt && typeof prompt.identifier === 'string')
            .map((prompt: any) => prompt.identifier),
    );
    list.order = replacementPromptOrder(entries, validIds)
        .map((entry) => ({ ...existing.get(entry.identifier), ...entry }));
}

/** 清理目标策略 prompt_order 列表里引用已不存在 prompt 的孤儿条目。 */
export function pruneStaleOrderEntries(preset: Preset): void {
    if (!Array.isArray(preset.prompts)) return;
    const list = findOrderList(preset, resolvePromptOrderTarget());
    if (!Array.isArray(list?.order)) return;
    const validIds = new Set<string>();
    for (const p of preset.prompts) {
        if (p && typeof p.identifier === 'string' && p.identifier) validIds.add(p.identifier);
    }
    const filtered = list.order.filter((o: any) => o && validIds.has(o.identifier));
    if (filtered.length !== list.order.length) {
        list.order = filtered;
    }
}

/**
 * 递归解析一个 profile 的完整 v3 挂载状态（含 fields、unused 收尾）。
 * - base：直接返回 prompts（arrange 后）；
 * - delta：先解析 parent，再叠加 changes。
 * 共用递归 + seen 防环骨架。
 */
export function resolveProfilePrompts(
    profile: PromptBaseProfile | PromptDeltaProfile,
    allProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
    seen: Set<string> = new Set(),
): PromptProfileEntry[] {
    if (!profile || seen.has(profile.id)) return [];
    seen.add(profile.id);

    if (isPromptBaseProfile(profile)) {
        const arranged = arrangePromptEntries(structuredClone(profile.prompts), mountedOrder(profile.prompts));
        // 并入 unusedIds 为 mounted:false 条目（unused prompt 展示/diff 可见；加载时 replaceTargetPromptOrder 仍不挂载）。
        // Array.isArray 守卫防御畸形数据（unusedIds 非数组时静默跳过，不崩溃）。
        if (Array.isArray(profile.unusedIds) && profile.unusedIds.length > 0) {
            const known = new Set(arranged.map((e) => e.identifier));
            const unusedEntries: PromptProfileEntry[] = profile.unusedIds
                .filter((id) => typeof id === 'string' && !known.has(id))
                .map((id) => ({ identifier: id, mounted: false, enabled: false }));
            return [...arranged, ...unusedEntries];
        }
        return arranged;
    }

    // 非 delta（未知/畸形类型）无父链可解析，安全返回空，绝不抛错
    if (!isPromptDeltaProfile(profile)) {
        return [];
    }

    const parent = allProfiles.find((p) => p.id === profile.baseId);
    const entries = parent ? resolveProfilePrompts(parent, allProfiles, seen) : [];
    return applyPromptDelta(entries, profile.changes, profile.order);
}

/**
 * 解析 delta 的直接父 profile（按 baseId 查找，递归走完父链）的有效挂载状态。
 */
export function resolveParentStates(
    profile: PromptDeltaProfile,
    allProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
): PromptProfileEntry[] {
    const parent = allProfiles.find((p) => p.id === profile.baseId);
    return parent ? resolveProfilePrompts(parent, allProfiles) : [];
}
