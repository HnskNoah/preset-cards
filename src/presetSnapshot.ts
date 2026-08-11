// defaultSnapshot（隐藏默认基准）的生成、合并与应用。
// 纯数据操作 + ST openai 全局；不接触 dialog/DOM。

import { L } from './i18n.js';
import type { Preset, PresetMeta, PromptBaseProfile, PromptDeltaChange, PromptDeltaProfile, PromptProfileEntry } from './meta.js';
import { isPromptBaseProfile, readMeta, saveMeta } from './meta.js';
import type { PromptEditBuffer } from './presetBuffers.js';
import { bufferKey, bufferPrefix } from './presetBuffers.js';
import { buildDefaultSnapshotLock, captureExtra, captureSampling, findPromptInPreset, filterFields, promptFieldsEqual, resolveParentStates, snapshotToChanges, snapshotToDelta } from './promptToggle.js';
import { entriesFromDefaultSnapshot } from './promptState.js';

// 首次对该预设 add base 时全量锁定默认基线：全部 prompt 采集挂载态 + 原始值字段；
// 同时锁定出厂采样基线（defaultSampling）与出厂 extra 基线（defaultExtra）。
// 写入 meta.defaultSnapshot + defaultSampling + defaultExtra 并持久化。幂等：defaultSnapshotLocked 为 true 时不覆盖（仅首次点加号锁定一次）。
export async function lockDefaultSnapshot(preset: Preset, name: string, idx: number): Promise<void> {
    const meta = readMeta(preset);
    if (meta.defaultSnapshotLocked) return;
    meta.defaultSnapshot = buildDefaultSnapshotLock(preset);
    meta.defaultSnapshotLocked = true;
    meta.defaultSampling = captureSampling(preset) ?? undefined;
    meta.defaultExtra = captureExtra(preset as Record<string, unknown>) ?? undefined;
    await saveMeta(name, idx, meta);
}

// 把当前挂载状态快照合并进主 profile（「保存→更新」与「覆盖」共用）：
// entries 覆盖当前快照；fields 仅对本次会话编辑过且有净变化的条目写回，其余条目保留既有 fields，
// 避免重建快照时丢失此前已保存的值编辑。unusedIds 随快照整体更新。
export function mergeBaseSnapshot(
    profile: PromptBaseProfile,
    snapshot: { entries: PromptProfileEntry[]; unusedIds: string[] },
    name: string,
    sessionEdits: Map<string, PromptEditBuffer>,
): void {
    const previousPrompts = profile.prompts;
    profile.prompts = snapshot.entries.map((s) => {
        const entry: PromptProfileEntry = {
            identifier: s.identifier,
            mounted: s.mounted,
            enabled: s.enabled,
        };
        if (s.lastActiveIndex !== undefined) entry.lastActiveIndex = s.lastActiveIndex;
        const session = sessionEdits.get(bufferKey(name, s.identifier));
        if (session && s.fields && !promptFieldsEqual(s.fields, session.initial)) {
            entry.fields = s.fields;
        } else if (!session) {
            const prior = previousPrompts.find((p) => p.identifier === s.identifier)?.fields;
            if (prior) entry.fields = prior;
        }
        return entry;
    });
    if (snapshot.unusedIds.length > 0) profile.unusedIds = snapshot.unusedIds;
    else delete profile.unusedIds;
}

// 把本次编辑过的条目的原始值字段惰性写入 defaultSnapshot（已存在则不覆盖）。
// 只在 base 保存路径调用：defaultSnapshot 可能尚不存在（首次打开才生成），此时跳过。
export function recordDefaultOriginalFields(meta: PresetMeta, name: string, sessionEdits: Map<string, PromptEditBuffer>): void {
    if (!Array.isArray(meta.defaultSnapshot)) return;
    const prefix = bufferPrefix(name);
    for (const [key, session] of sessionEdits) {
        if (!key.startsWith(prefix)) continue;
        const identifier = key.slice(prefix.length);
        const entry = meta.defaultSnapshot.find((d) => d.identifier === identifier);
        if (!entry || entry.originalFields) continue;
        entry.originalFields = { ...filterFields(session.initial) };
    }
}

// 把 defaultSnapshot 记录的原始值字段应用回 preset（reset 到默认时还原首次编辑前的值）。
export function applyDefaultOriginalFields(preset: Preset, meta: PresetMeta): void {
    if (!Array.isArray(meta.defaultSnapshot)) return;
    for (const d of meta.defaultSnapshot) {
        if (!d.originalFields) continue;
        const prompt = findPromptInPreset(preset, d.identifier);
        if (prompt) Object.assign(prompt, filterFields(d.originalFields));
    }
}

// 把出厂采样基线应用回 preset（reset 到默认时还原首次 add base 前的采样参数）。
export function applyDefaultSampling(preset: Preset, meta: PresetMeta): void {
    if (!meta.defaultSampling) return;
    const target = preset as Record<string, unknown>;
    for (const [key, value] of Object.entries(meta.defaultSampling)) {
        if (value !== undefined) target[key] = value;
    }
}

// 把出厂 extra 基线应用回 preset（reset 到默认时还原首次 add base 前的附加键值，保留 extensions）。
// profile 自身 extra 不在此改变——reset 仅还原预设，v1 导入 profile 的 extra 保留存档不变。
export function applyDefaultExtra(preset: Preset, meta: PresetMeta): void {
    if (!meta.defaultExtra) return;
    const ext = preset.extensions;
    Object.assign(preset, meta.defaultExtra);
    preset.extensions = ext;
}

/** defaultSnapshot 中出厂挂载的完整 v3 条目（reset 到默认时还原出厂挂载态+顺序+原始值）。
 * 不按当前 order 过滤：reset 语义是「回出厂挂载态」，用户/导入造成的挂载差异一律被出厂态覆盖。 */
export function defaultEnabledEntries(meta: PresetMeta): PromptProfileEntry[] {
    if (!Array.isArray(meta.defaultSnapshot)) return [];
    return entriesFromDefaultSnapshot(meta.defaultSnapshot).filter((e) => e.mounted);
}

/** 「保存→更新」与「覆盖」共用的 base/delta 提交：按类型合并缓冲后的快照 → 持久化 → 成功提示。
 * missingParent 为 delta 父链缺失时的分歧路径：
 *   'full-changes'（保存→更新）：全量写成差异（含值字段）继续提交；
 *   'abort'（覆盖）：toast 提示并返回 false，调用方中止后续。
 * 仅处理 base/delta；成功时返回 true。 */
export async function commitBufferedEditsToProfile(
    profile: PromptBaseProfile | PromptDeltaProfile,
    snapshot: { entries: PromptProfileEntry[]; unusedIds: string[] },
    meta: PresetMeta,
    name: string,
    idx: number,
    sessionEdits: Map<string, PromptEditBuffer>,
    missingParent: 'full-changes' | 'abort',
): Promise<boolean> {
    if (isPromptBaseProfile(profile)) {
        // enabled 合并当前目标 order 中的条目；fields 仅对本次编辑的条目（与编辑初值无净变化时清除），
        // 其余条目保留既有 fields（见 mergeBaseSnapshot）
        mergeBaseSnapshot(profile, snapshot, name, sessionEdits);
        recordDefaultOriginalFields(meta, name, sessionEdits);
    } else {
        // 基线用父链解析状态（不含本 delta 自身 changes），否则未编辑的已存差异与基线相等而被 diff 掉
        const parentEntries = resolveParentStates(profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]);
        if (parentEntries.length > 0) {
            // 挂载/卸载差异全走 changes（含 unmount 的 mounted:false），顺序差异走 order（纯顺序）
            const deltaState = snapshotToDelta(snapshot.entries, parentEntries, snapshot.unusedIds);
            profile.changes = snapshotToChanges(snapshot.entries, parentEntries, profile.changes, snapshot.unusedIds);
            if (deltaState.order) profile.order = deltaState.order;
            else delete profile.order;
        } else if (missingParent === 'full-changes') {
            // 父链缺失：全量写成差异（含挂载态+值字段）；空 fields（clear 条目）不写入（F3）。
            // mounted 必须显式：父缺失时 applyPromptDelta 对无 mounted 的 change 默认 unused → 全部卸载。
            // unusedIds 中的条目标记为 mounted:false，其余挂载。
            const unusedSet = new Set(snapshot.unusedIds);
            profile.changes = snapshot.entries.map((s) => {
                const change: PromptDeltaChange = { identifier: s.identifier, mounted: !unusedSet.has(s.identifier), enabled: s.enabled };
                if (s.fields && Object.keys(s.fields).length > 0) change.fields = s.fields;
                return change;
            });
            // 同步清空/设置 order：以快照 mounted 顺序为准
            const currentOrder = snapshot.entries.filter((s) => !unusedSet.has(s.identifier)).map((s) => s.identifier);
            if (currentOrder.length > 0) profile.order = currentOrder;
            else delete profile.order;
        } else {
            toastr.warning(L('Base profile not found, cannot update derived configuration'));
            return false;
        }
        recordDefaultOriginalFields(meta, name, sessionEdits);
    }

    await saveMeta(name, idx, meta);
    toastr.success(L('Configuration updated'));
    return true;
}
