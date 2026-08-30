// profileEditorBaseline：编辑器基线解析与漂移种子。
// 唯一基线语义的载体：基线条目 = profile 解析态；有效值字段 = 出厂 originalFields ⊕ 解析 fields；
// 漂移种子 = 字段级流下把父预设相对基线的原生编辑预填为可见 staged 项。
import { oai_settings, openai_settings } from '@sillytavern/scripts/openai';
import { getProfile, isPromptBaseProfile, isPromptDeltaProfile, readMeta } from './meta.js';
import type { Preset, PresetMeta, PromptBaseProfile, PromptDeltaProfile, PromptFields, PromptProfileEntry } from './meta.js';
import { getActiveProfile } from './activeProfile.js';
import { bufferKey } from './presetBuffers.js';
import {
    PROMPT_FIELD_WHITELIST,
    capturePromptFields,
    filterFields,
    findOrderList,
    findPromptInPreset,
    resolveProfilePrompts,
    resolvePromptOrderTarget,
} from './promptToggle.js';
import type { EditorContext } from './profileEditorContext.js';

/** 编辑器基线条目：当前 profile 的解析态（唯一基线语义，提交/预填/漂移种子共用）。 */
export function resolveBaselineEntries(ctx: EditorContext): PromptProfileEntry[] {
    const preset = openai_settings[ctx.idx] as Preset;
    const meta = readMeta(preset);
    const profile = getProfile(meta, ctx.profileId);
    if (!profile || (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile))) return [];
    return resolveProfilePrompts(profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[], new Set());
}

/** 条目的「有效值字段」= 出厂 originalFields ⊕ profile 解析 fields（与 applyProfileToPreset 的应用序一致）。
 * 出厂基线缺失时回退预设定义。注册投影流下父预设定义与编辑态无关，值编辑/提交快照必须用本函数的有效值。 */
export function effectiveFieldsFor(meta: PresetMeta, entry: PromptProfileEntry, promptDef: any): PromptFields {
    const factory = meta.defaultSnapshot?.find((d) => d.identifier === entry.identifier)?.originalFields;
    return {
        ...(factory ? filterFields(factory) : capturePromptFields(promptDef)),
        ...(entry.fields ? filterFields(entry.fields) : {}),
    };
}

/** 全量有效值字段表（提交快照与编辑预填共用）。 */
export function buildEffectiveFieldsMap(preset: Preset, ctx: EditorContext): Map<string, PromptFields> {
    const meta = readMeta(preset);
    const map = new Map<string, PromptFields>();
    for (const entry of resolveBaselineEntries(ctx)) {
        map.set(entry.identifier, effectiveFieldsFor(meta, entry, findPromptInPreset(preset, entry.identifier)));
    }
    return map;
}

/** 打开编辑器时把「父预设当前持有本 profile 字段级应用态」的漂移预填进会话缓冲（可见的 staged 项）。
 * 字段级流下原生 PM 的开关/挂载/顺序/值编辑是唯一漂移来源；种子化后用户可逐项撤销或随 commit 固化，
 * 不再有「commit 时静默折叠进基线」。注册投影流下父预设状态与本 profile 无关，不种子
 * （漂移由 SETTINGS_UPDATED 捕获链路处理）。 */
export function seedPresetDriftIntoBuffers(ctx: EditorContext): void {
    if (oai_settings.preset_settings_openai !== ctx.name) return;
    const active = getActiveProfile();
    if (!active || active.presetName !== ctx.name || active.profileId !== String(ctx.profileId)) return;

    const preset = openai_settings[ctx.idx] as Preset;
    const meta = readMeta(preset);
    const resolved = resolveBaselineEntries(ctx);
    if (resolved.length === 0) return;

    const targetId = resolvePromptOrderTarget();
    const list = findOrderList(preset, targetId);
    const presetOrder: { identifier: string; enabled: boolean }[] = Array.isArray(list?.order)
        ? list.order
            .filter((o: any) => o && typeof o.identifier === 'string')
            .map((o: any) => ({ identifier: o.identifier, enabled: o.enabled === true }))
        : [];

    const resolvedById = new Map(resolved.map((e) => [e.identifier, e]));
    const resolvedMounted = resolved.filter((e) => e.mounted);
    const resolvedMountIdx = new Map(resolvedMounted.map((e, i) => [e.identifier, i]));

    // 种子 sessionOrder = 预设当前 order ∩ profile 解析域（保持预设现行顺序；域外条目不属于本 profile）
    const seeded = presetOrder.filter((o) => resolvedById.has(o.identifier));
    ctx.sessionOrder = seeded.map((o) => ({ ...o }));
    const seededIdx = new Map(seeded.map((o, i) => [o.identifier, i]));

    for (const entry of resolvedMounted) {
        const key = bufferKey(ctx.name, entry.identifier);
        const presetIdx = seededIdx.get(entry.identifier);
        if (presetIdx === undefined) {
            // 漂移卸载：profile 挂载、预设 order 已摘除 → 预填卸载。
            // unmountPositions 记「种子域」插入位（种子 order 中解析位在其之前的条目数）——
            // undo 插回与 sessionOrder 的预设域顺序同一索引空间，顺序漂移共存时也落对位。
            const resolvedIdx = resolvedMountIdx.get(entry.identifier) ?? 0;
            const insertPos = seeded.filter((o) => {
                const ri = resolvedMountIdx.get(o.identifier);
                return ri !== undefined && ri < resolvedIdx;
            }).length;
            ctx.pendingMounts.set(key, false);
            ctx.unmountPositions.set(key, insertPos);
            continue;
        }
        // 开关漂移：预设真值 ≠ profile 解析值 → 预填 toggle
        if (seeded[presetIdx].enabled !== entry.enabled) {
            ctx.pendingToggles.set(key, seeded[presetIdx].enabled);
        }
        // 顺序漂移
        if (presetIdx !== resolvedMountIdx.get(entry.identifier)) {
            ctx.reorderedIds.add(entry.identifier);
        }
    }
    // 漂移重挂载：profile 未挂载、预设 order 有 → 预填挂载
    for (const o of seeded) {
        const entry = resolvedById.get(o.identifier)!;
        if (!entry.mounted) {
            ctx.pendingMounts.set(bufferKey(ctx.name, o.identifier), true);
        }
    }
    // 值漂移：预设定义 ≠ 有效值字段（出厂 ⊕ 解析）→ 预填会话值编辑
    for (const entry of resolved) {
        const def = findPromptInPreset(preset, entry.identifier);
        if (!def) continue;
        const eff = effectiveFieldsFor(meta, entry, def);
        const drift: PromptFields = {};
        for (const f of PROMPT_FIELD_WHITELIST) {
            const defValue = (def as any)[f];
            if (defValue !== undefined && defValue !== (eff as any)[f]) {
                (drift as any)[f] = defValue;
            }
        }
        if (Object.keys(drift).length === 0) continue;
        ctx.sessionEdits.set(bufferKey(ctx.name, entry.identifier), { initial: { ...eff }, edited: { ...eff, ...drift } });
    }
}
