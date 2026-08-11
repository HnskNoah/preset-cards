// defaultSnapshot（隐藏默认基准）的生成、合并与应用。
// 纯数据操作 + ST openai 全局；不接触 dialog/DOM。

import type { Preset, PresetMeta, PromptBaseProfile, PromptFields } from './meta.js';
import { readMeta, saveMeta } from './meta.js';
import type { PromptEditBuffer } from './presetBuffers.js';
import { bufferKey, bufferPrefix } from './presetBuffers.js';
import { buildDefaultSnapshotLock, captureExtra, findOrderList, findPromptInPreset, filterFields, promptFieldsEqual, resolvePromptOrderTarget } from './promptToggle.js';

// 首次对该预设 add base 时全量锁定默认基线：全部 prompt 采集 originalFields，仅 mounted prompt 采集 enabled；
// 同时锁定出厂 extra 基线（captureExtra 采当前预设的非采样/非 prompts 键）。
// 写入 meta.defaultSnapshot + defaultExtra 并持久化。幂等：defaultSnapshotLocked 为 true 时不覆盖（仅首次点加号锁定一次）。
export async function lockDefaultSnapshot(preset: Preset, name: string, idx: number): Promise<void> {
    const meta = readMeta(preset);
    if (meta.defaultSnapshotLocked) return;
    meta.defaultSnapshot = buildDefaultSnapshotLock(preset);
    meta.defaultSnapshotLocked = true;
    meta.defaultExtra = captureExtra(preset as Record<string, unknown>) ?? undefined;
    await saveMeta(name, idx, meta);
}

// 把当前开关/值快照合并进主 profile（「保存→更新」与「覆盖」共用）：
// enabled 回写当前目标 order 中的条目；fields 仅对本次会话编辑过且有净变化的条目写回，其余条目保留既有 fields，
// 避免重建快照时丢失此前已保存的值编辑。
export function mergeBaseSnapshot(profile: PromptBaseProfile, snapshot: { identifier: string; enabled: boolean; fields?: PromptFields }[], name: string, sessionEdits: Map<string, PromptEditBuffer>): void {
    const previousPrompts = profile.prompts;
    profile.prompts = snapshot.map((s) => {
        const entry: { identifier: string; enabled: boolean; fields?: PromptFields } = {
            identifier: s.identifier,
            enabled: s.enabled,
        };
        const session = sessionEdits.get(bufferKey(name, s.identifier));
        if (session && s.fields && !promptFieldsEqual(s.fields, session.initial)) {
            entry.fields = s.fields;
        } else if (!session) {
            const prior = previousPrompts.find((p) => p.identifier === s.identifier)?.fields;
            if (prior) entry.fields = prior;
        }
        return entry;
    });
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

// 把出厂 extra 基线应用回 preset（reset 到默认时还原首次 add base 前的附加键值，保留 extensions）。
// profile 自身 extra 不在此改变——reset 仅还原预设，v1 导入 profile 的 extra 保留存档不变。
export function applyDefaultExtra(preset: Preset, meta: PresetMeta): void {
    if (!meta.defaultExtra) return;
    const ext = preset.extensions;
    Object.assign(preset, meta.defaultExtra);
    preset.extensions = ext;
}

/** defaultSnapshot 中有明确开关、且当前仍 mounted 的条目；兼容旧快照为 unused 保存了布尔值的情况。 */
export function defaultEnabledEntries(preset: Preset, meta: PresetMeta): PromptBaseProfile['prompts'] {
    if (!Array.isArray(meta.defaultSnapshot)) return [];
    const orderList = findOrderList(preset, resolvePromptOrderTarget());
    const mounted = new Set<string>(Array.isArray(orderList?.order)
        ? orderList.order
            .filter((entry: any) => entry && typeof entry.identifier === 'string')
            .map((entry: any) => entry.identifier)
        : []);
    return meta.defaultSnapshot.flatMap((entry) => typeof entry.enabled === 'boolean' && mounted.has(entry.identifier)
        ? [{ identifier: entry.identifier, enabled: entry.enabled }]
        : []);
}
