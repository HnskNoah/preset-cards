// defaultSnapshot（隐藏默认基准）的生成、合并与应用。
// 纯数据操作 + ST openai 全局；不接触 dialog/DOM。

import { L } from './i18n.js';
import type { Preset, PresetMeta, PromptBaseProfile, PromptDeltaChange, PromptDeltaProfile, PromptProfileEntry } from './meta.js';
import { isPromptBaseProfile, readMeta, saveMeta, saveMetaMerged } from './meta.js';
import type { PromptEditBuffer } from './presetBuffers.js';
import { bufferKey, bufferPrefix } from './presetBuffers.js';
import { buildDefaultSnapshotLock, captureExtra, captureSampling, findPromptInPreset, filterFields, promptFieldsEqual, resolveParentStates, snapshotToChanges, snapshotToDelta } from './promptToggle.js';
import { entriesFromDefaultSnapshot } from './promptState.js';

/** 迁移 v2（formatVersion 2）profile 到 v3：识别并转换该预设的全部 v2 base/delta。
 * 返回是否发生了迁移（调用方据此决定是否落盘）。
 * - v2 base：prompts[].mounted 补 true、lastActiveIndex 按数组序（v2 顺序即挂载顺序），formatVersion → 3；
 *   采样/extra 保留。
 * - v2 delta：changes 保留（mounted 继承父链，不冗余补），formatVersion → 3；采样/extra 保留。
 * v2 无独立 order 字段（顺序隐含在数组序），delta 的顺序信息 v2 本就没有，迁移不虚构。 */
export function migrateLegacyV2Profiles(meta: PresetMeta): boolean {
    if (!Array.isArray(meta.profiles)) return false;
    let changed = false;
    meta.profiles = meta.profiles.map((p) => {
        const raw = p as Record<string, any>;
        if (raw.formatVersion !== 2) return p;
        if (raw.kind === 'prompt_base' && Array.isArray(raw.prompts)) {
            changed = true;
            const base: PromptBaseProfile = {
                formatVersion: 3,
                kind: 'prompt_base',
                id: raw.id,
                name: raw.name,
                prompts: raw.prompts.map((entry: any, i: number) => ({
                    identifier: entry.identifier,
                    mounted: true,
                    enabled: entry.enabled,
                    ...(i > 0 || raw.prompts.length > 1 ? { lastActiveIndex: i } : {}),
                    ...(entry.fields ? { fields: { ...entry.fields } } : {}),
                })),
                ...(raw.sampling ? { sampling: raw.sampling } : {}),
                ...(raw.extra ? { extra: raw.extra } : {}),
            };
            return base;
        }
        if (raw.kind === 'prompt_delta' && Array.isArray(raw.changes)) {
            changed = true;
            const delta: PromptDeltaProfile = {
                formatVersion: 3,
                kind: 'prompt_delta',
                id: raw.id,
                name: raw.name,
                baseId: raw.baseId,
                changes: raw.changes as PromptDeltaChange[],
                ...(raw.sampling ? { sampling: raw.sampling } : {}),
                ...(raw.extra ? { extra: raw.extra } : {}),
            };
            return delta;
        }
        return p;
    });
    return changed;
}

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

/** defaultSnapshot 中出厂挂载的 v3 条目（reset 到默认时还原出厂挂载态+顺序）。
 * 不按当前 order 过滤：reset 语义是「回出厂挂载态」，用户/导入造成的挂载差异一律被出厂态覆盖。
 * 不带 fields：出厂值由 applyDefaultOriginalFields 还原到预设，base.prompts 只记挂载态/开关/顺序，
 * 避免 reset 后所有条目被标成「有值差异」（fields 是相对基线的差异，回出厂应无差异）。 */
export function defaultEnabledEntries(meta: PresetMeta): PromptProfileEntry[] {
    if (!Array.isArray(meta.defaultSnapshot)) return [];
    return entriesFromDefaultSnapshot(meta.defaultSnapshot)
        .filter((e) => e.mounted)
        .map((e) => {
            const entry: PromptProfileEntry = { identifier: e.identifier, mounted: true, enabled: e.enabled };
            if (e.lastActiveIndex !== undefined) entry.lastActiveIndex = e.lastActiveIndex;
            return entry;
        });
}

/** 「保存→更新」与「覆盖」共用的 base/delta 提交：按类型合并缓冲后的快照 → 持久化 → 成功提示。
 * missingParent 为 delta 父链缺失时的分歧路径：
 *   'full-changes'（保存→更新）：全量写成差异（含值字段）继续提交；
 *   'abort'（覆盖）：toast 提示并返回 false，调用方中止后续。
 * 仅处理 base/delta；成功时返回 true。
 * 副作用后置：merge 作用到 profile 深副本，saveMeta 成功后才写回 meta.profiles 原槽位——
 * 失败时源 profile 内存不被污染（与「缓冲保留可重试」语义一致）。 */
export async function commitBufferedEditsToProfile(
    profile: PromptBaseProfile | PromptDeltaProfile,
    snapshot: { entries: PromptProfileEntry[]; unusedIds: string[] },
    meta: PresetMeta,
    name: string,
    idx: number,
    sessionEdits: Map<string, PromptEditBuffer>,
    missingParent: 'full-changes' | 'abort',
): Promise<boolean> {
    // 传入 profile 即为副本（调用方 commitUpdate 已 structuredClone + 应用 clears）；成功持久化后才替换原 profile
    const nextProfile = profile;
    if (isPromptBaseProfile(nextProfile)) {
        // enabled 合并当前目标 order 中的条目；fields 仅对本次编辑的条目（与编辑初值无净变化时清除），
        // 其余条目保留既有 fields（见 mergeBaseSnapshot）
        mergeBaseSnapshot(nextProfile, snapshot, name, sessionEdits);
    } else {
        // 基线用父链解析状态（不含本 delta 自身 changes），否则未编辑的已存差异与基线相等而被 diff 掉
        const parentEntries = resolveParentStates(nextProfile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]);
        if (parentEntries.length > 0) {
            // 挂载/卸载差异全走 changes（含 unmount 的 mounted:false），顺序差异走 order（纯顺序）
            const deltaState = snapshotToDelta(snapshot.entries, parentEntries, snapshot.unusedIds);
            nextProfile.changes = snapshotToChanges(snapshot.entries, parentEntries, nextProfile.changes, snapshot.unusedIds);
            if (deltaState.order) nextProfile.order = deltaState.order;
            else delete nextProfile.order;
        } else if (missingParent === 'full-changes') {
            // 父链缺失：全量写成差异（含挂载态+值字段）；空 fields（clear 条目）不写入（F3）。
            // mounted 必须显式：父缺失时 applyPromptDelta 对无 mounted 的 change 默认 unused → 全部卸载。
            // unusedIds 中的条目标记为 mounted:false，其余挂载。
            const unusedSet = new Set(snapshot.unusedIds);
            nextProfile.changes = snapshot.entries.map((s) => {
                const change: PromptDeltaChange = { identifier: s.identifier, mounted: !unusedSet.has(s.identifier), enabled: s.enabled };
                if (s.fields && Object.keys(s.fields).length > 0) change.fields = s.fields;
                return change;
            });
            // 同步清空/设置 order：以快照 mounted 顺序为准
            const currentOrder = snapshot.entries.filter((s) => !unusedSet.has(s.identifier)).map((s) => s.identifier);
            if (currentOrder.length > 0) nextProfile.order = currentOrder;
            else delete nextProfile.order;
        } else {
            toastr.warning(L('Base profile not found, cannot update derived configuration'));
            return false;
        }
    }
    // 把副本替换进 meta.profiles 对应槽位，持久化含新 profile 的 meta
    const profiles = Array.isArray(meta.profiles) ? meta.profiles : [];
    const slot = profiles.findIndex((p: any) => String(p?.id) === String(profile.id));
    const nextProfiles = slot >= 0
        ? profiles.map((p: any, i: number) => (i === slot ? nextProfile : p))
        : [...profiles, nextProfile];
    const nextMeta = { ...meta, profiles: nextProfiles };
    recordDefaultOriginalFields(nextMeta, name, sessionEdits);
    // 先同步内存：合并保存窗口内后续 commit 基于最新 profiles（否则窗口内第 2 次会覆盖第 1 次改动）
    meta.profiles = nextProfiles;
    try {
        await saveMetaMerged(name, idx, nextMeta);
    } catch (err) {
        // 保存失败回滚内存，与副本模式失败语义一致
        meta.profiles = profiles;
        throw err;
    }
    toastr.success(L('Configuration updated'));
    return true;
}
