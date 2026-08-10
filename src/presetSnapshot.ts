// defaultSnapshot（隐藏默认基准）的生成、合并与应用。
// 纯数据操作 + ST openai 全局；不接触 dialog/DOM。

import type { Preset, PresetMeta, PromptBaseProfile, PromptProfileEntry } from './meta.js';
import { readMeta, saveMeta } from './meta.js';
import type { PromptEditBuffer } from './presetBuffers.js';
import { bufferKey, bufferPrefix } from './presetBuffers.js';
import { buildDefaultSnapshotLock, findPromptInPreset, filterFields, promptFieldsEqual } from './promptToggle.js';

// 首次对该预设 add base 时全量锁定默认基线：采集全部 prompts 的 {identifier, enabled, originalFields}（白名单5键全量）
// 写入 meta.defaultSnapshot 并持久化。幂等：defaultSnapshotLocked 为 true 时不覆盖（仅首次点加号锁定一次）。
// 取代旧 ensureDefaultSnapshots 的「仅开关快照 + 打开面板批量回填」——现在只在用户对该预设首次 add base 时锁定，
// 提供 reset 的可靠出厂基线，也让 add base 能按「与基线的差异」存储（见 buildBaseSnapshotDiff）。
export async function lockDefaultSnapshot(preset: Preset, name: string, idx: number): Promise<void> {
    const meta = readMeta(preset);
    if (meta.defaultSnapshotLocked && meta.defaultSnapshot?.every((entry) => typeof entry.mounted === 'boolean')) return;
    meta.defaultSnapshot = buildDefaultSnapshotLock(preset);
    meta.defaultSnapshotLocked = true;
    await saveMeta(name, idx, meta);
}

// 把当前开关/值快照合并进主 profile（「保存→更新」与「覆盖」共用）：
// enabled 回写当前目标 order 中的条目；fields 仅对本次会话编辑过且有净变化的条目写回，其余条目保留既有 fields，
// 避免重建快照时丢失此前已保存的值编辑。
export function mergeBaseSnapshot(profile: PromptBaseProfile, snapshot: PromptProfileEntry[], name: string, sessionEdits: Map<string, PromptEditBuffer>): void {
    const previousPrompts = profile.prompts;
    profile.prompts = snapshot.map((s) => {
        const entry: PromptProfileEntry = {
            identifier: s.identifier,
            mounted: s.mounted,
            enabled: s.enabled,
            lastActiveIndex: s.lastActiveIndex,
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
