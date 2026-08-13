import type { Preset, PromptDefaultSnapshotEntry, PromptDeltaChange, PromptFields, PromptProfileEntry } from './meta.js';
import { diffPromptState, snapshotPromptState } from './promptState.js';
import { filterFields, capturePromptFields, findPromptInPreset, PROMPT_FIELD_WHITELIST } from './promptCapture.js';
import { findOrderList, resolvePromptOrderTarget } from './promptOrder.js';

// ─── re-export：采集侧（promptCapture.ts）与应用侧（promptApply.ts）的函数统一经本文件暴露，
// ─── 保持既有 `from './promptToggle.js'` 调用方不变。
export { PROMPT_FIELD_WHITELIST, promptFieldsEqual, captureSampling, applySampling, captureExtra, applyExtra, diffSampling, diffExtra, capturePromptFields, captureModel, applyModel, filterFields, mirrorFieldsToActivePreset, findPromptInPreset, EXTRA_EXCLUDED_KEYS } from './promptCapture.js';
export { applyEntryState, buildDefaultSnapshotLock, applyResolvedPromptState, applyBaseProfile, applyProfileToPreset, resolveProfileModel, collectProfileChain, resolveEffectiveSampling, resolveEffectiveExtra } from './promptApply.js';
export { findOrderList, resolvePromptOrderTarget, syncPromptOrder, replaceTargetPromptOrder, pruneStaleOrderEntries, resolveProfilePrompts, resolveParentStates } from './promptOrder.js';

/**
 * 采集当前目标 prompt_order 的 v3 挂载状态快照（mounted + unusedIds）。
 * includeFields 含某 identifier 时附带 fields: capturePromptFields(prompt)。
 */
export function buildPromptSnapshot(
    preset: Preset,
    opts?: { includeFields?: Set<string> },
): { entries: PromptProfileEntry[]; unusedIds: string[] } {
    if (!Array.isArray(preset.prompts)) return { entries: [], unusedIds: [] };
    const target = resolvePromptOrderTarget();
    const prompts = preset.prompts.filter((p: any) => p && typeof p.identifier === 'string' && p.identifier);
    const list = findOrderList(preset, target);
    const { entries, unusedIds } = snapshotPromptState(prompts, Array.isArray(list?.order) ? list.order : []);
    for (const entry of entries) {
        if (opts?.includeFields?.has(entry.identifier)) {
            entry.fields = capturePromptFields(findPromptInPreset(preset, entry.identifier));
        }
    }
    return { entries, unusedIds };
}

/**
 * 基于锁定基线的 base 快照（add base 用）：
 * 完整 v3 挂载态 + 相对基线的值字段差异。
 */
export function buildBaseSnapshot(
    preset: Preset,
    baseline: PromptDefaultSnapshotEntry[] | null | undefined,
): { entries: PromptProfileEntry[]; unusedIds: string[] } {
    const { entries, unusedIds } = buildPromptSnapshot(preset, {
        includeFields: new Set(
            (Array.isArray(preset.prompts) ? preset.prompts : [])
                .filter((p: any) => p && typeof p.identifier === 'string')
                .map((p: any) => p.identifier),
        ),
    });
    const baselineFields = new Map<string, PromptFields>();
    if (Array.isArray(baseline)) {
        for (const entry of baseline) {
            if (entry.originalFields) baselineFields.set(entry.identifier, entry.originalFields);
        }
    }
    for (const entry of entries) {
        const current = entry.fields ?? {};
        const base = baselineFields.get(entry.identifier);
        if (base) {
            const diff: Record<string, any> = {};
            let hasDiff = false;
            for (const key of PROMPT_FIELD_WHITELIST) {
                if (current[key] !== undefined && current[key] !== base[key]) {
                    diff[key] = current[key];
                    hasDiff = true;
                }
            }
            if (hasDiff) entry.fields = filterFields(diff);
            else delete entry.fields;
        }
    }
    return { entries, unusedIds };
}

/** 从快照生成派生差异（含挂载态/顺序/值字段）。
 * unusedIds 为快照的 unused 集合：对「父链 mounted 但当前 unused」产出 mounted:false change（unmount）。 */
export function snapshotToDelta(
    snapshot: PromptProfileEntry[],
    parentEntries: PromptProfileEntry[],
    unusedIds: string[] = [],
): { changes: PromptDeltaChange[]; order?: string[] } {
    const delta = diffPromptState(snapshot, parentEntries, unusedIds);
    return { changes: delta.changes as PromptDeltaChange[], order: delta.order };
}

/** 从快照生成派生差异（含挂载态/顺序/值字段）。
 * 保留 previousChanges 中「本批快照未编辑（fields 缺失）」条目的已存 fields，
 * 避免 delta 更新时未编辑条目的已持久化值差异被覆盖清除（v2 既有语义）。 */
export function snapshotToChanges(
    snapshot: PromptProfileEntry[],
    parentEntries: PromptProfileEntry[],
    previousChanges: PromptDeltaChange[] = [],
    unusedIds: string[] = [],
): PromptDeltaChange[] {
    const changes = snapshotToDelta(snapshot, parentEntries, unusedIds).changes;
    const prevById = new Map<string, Record<string, any>>(
        previousChanges.filter((c) => c.fields && Object.keys(c.fields).length > 0).map((c) => [c.identifier, c.fields!]),
    );
    if (prevById.size === 0) return changes;
    const snapFieldsById = new Map<string, PromptFields | undefined>(
        snapshot.map((s) => [s.identifier, s.fields]),
    );
    for (const [id, prevFields] of prevById) {
        const snapFields = snapFieldsById.get(id);
        // 本批未编辑（快照 fields 缺失）且 previous 有已存差异 → 保留 previous（被 clear 的条目快照 fields 为 {}，不在此列）
        if (snapFields === undefined) {
            const existing = changes.find((c) => c.identifier === id);
            if (existing) existing.fields = { ...prevFields };
            else changes.push({ identifier: id, fields: { ...prevFields } });
        }
    }
    return changes;
}
