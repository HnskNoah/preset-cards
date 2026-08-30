import { oai_settings, openai_settings } from '@sillytavern/scripts/openai';
import { EXTENSION_KEY } from './constants.js';
import { L } from './i18n.js';
import { getProfile, isPromptBaseProfile, isPromptDeltaProfile, readMeta, saveMeta } from './meta.js';
import type { Preset, PresetMeta, PromptBaseProfile, PromptDeltaProfile, PromptFields, PromptProfileEntry } from './meta.js';
import { applyBufferedEdits, bufferKey, bufferPrefix, clearBufferedForName, editedIdentifiersForName, type PromptEditBuffer } from './presetBuffers.js';
import type { ProfileEntryView } from './presetList.js';
import {
    PROMPT_FIELD_WHITELIST,
    buildPromptSnapshot,
    captureExtra,
    captureModel,
    capturePromptFields,
    captureSampling,
    diffExtra,
    diffSampling,
    filterFields,
    findOrderList,
    findPromptInPreset,
    resolveEffectiveExtra,
    resolveEffectiveSampling,
    resolveProfilePrompts,
    resolvePromptOrderTarget,
    snapshotToChanges,
    snapshotToDelta,
} from './promptToggle.js';
import { commitBufferedEditsToProfile, recordDefaultOriginalFields } from './presetSnapshot.js';
import { buildDerivedProfile } from './profileActions.js';
import { resetProfileCore } from './profileMutators.js';
import { resolveEditorSnapshot, type EditorContext, type EditorSnapshot } from './profileEditorContext.js';

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

/** 采集当前缓冲（开关/值编辑）叠加后的快照——纯函数，不写运行时。
 * 构造临时视图 preset（浅克隆 prompts + 叠加有效值字段与字段 edited；目标 order 由会话 sessionOrder 表达），
 * 使 buildPromptSnapshot 采到与「提交后」一致的状态；运行时 prompts/order 保持未动。
 * 副作用（applyBufferedEdits 写真实 prompt/镜像）由调用方在 commit 成功后执行。 */
export function applyBufferedAndSnapshot(
    preset: Preset,
    name: string,
    sessionEdits: Map<string, PromptEditBuffer>,
    pendingToggles: Map<string, boolean>,
    pendingClears: Map<string, true>,
    sessionOrder: { identifier: string; enabled: boolean }[],
    effectiveFields: Map<string, PromptFields>,
): { entries: PromptProfileEntry[]; unusedIds: string[] } {
    const prefix = bufferPrefix(name);
    // 临时视图：prompts 浅克隆叠加字段 edited；目标 order 用 sessionOrder（含开关目标值）替换。
    // 运行时 prompts/order 保持未动（单向数据流：编辑期不改 ST 状态）。
    const targetId = resolvePromptOrderTarget();
    const clonedLists = Array.isArray(preset.prompt_order)
        ? preset.prompt_order.map((list: any) => ({
            ...list,
            order: Array.isArray(list?.order) ? list.order.map((o: any) => ({ ...o })) : list?.order,
        }))
        : [];
    let targetList = clonedLists.find((l: any) => String(l?.character_id) === String(targetId));
    if (!targetList) {
        targetList = { character_id: targetId, order: [] };
        clonedLists.push(targetList);
    }
    targetList.order = sessionOrder.map((o) => ({ ...o }));
    const view = {
        ...preset,
        prompts: Array.isArray(preset.prompts)
            ? preset.prompts.map((p: any) => ({ ...p }))
            : [],
        prompt_order: clonedLists,
    };
    // 基线叠加：白名单值字段以「出厂 ⊕ profile 解析」的有效值为准，再叠会话编辑——
    // 注册流下父预设定义不代表编辑态，直接采集定义会把无关值钉进 profile fields
    for (const prompt of view.prompts) {
        const eff = effectiveFields.get(String(prompt.identifier));
        if (eff) Object.assign(prompt, eff);
    }
    const viewById = new Map(view.prompts.map((p: any) => [p.identifier, p]));
    for (const [key, session] of sessionEdits) {
        if (!key.startsWith(prefix)) continue;
        const prompt = viewById.get(key.slice(prefix.length));
        if (prompt) Object.assign(prompt, filterFields(session.edited));
    }
    // 缺失条目：沿用原 applyBufferedEdits 的 missing 提示语义（纯计算）
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const [key] of pendingToggles) {
        if (!key.startsWith(prefix)) continue;
        const identifier = key.slice(prefix.length);
        if (!viewById.has(identifier) && !seen.has(identifier)) {
            seen.add(identifier);
            missing.push(identifier);
        }
    }
    for (const [key] of sessionEdits) {
        if (!key.startsWith(prefix)) continue;
        const identifier = key.slice(prefix.length);
        if (!viewById.has(identifier) && !seen.has(identifier)) {
            seen.add(identifier);
            missing.push(identifier);
        }
    }
    if (missing.length > 0) {
        toastr.warning(`${L('Missing prompts skipped')}: ${missing.join(', ')}`);
    }
    const include = editedIdentifiersForName(name, sessionEdits);
    for (const key of pendingClears.keys()) {
        if (key.startsWith(prefix)) include.add(key.slice(prefix.length));
    }
    const snapshot = buildPromptSnapshot(view, { includeFields: include });
    for (const entry of snapshot.entries) {
        const key = bufferKey(name, entry.identifier);
        if (pendingClears.has(key) && !sessionEdits.has(key)) {
            entry.fields = {};
        }
    }
    return snapshot;
}

/** 把「清除值变更」应用到 profile 快照：删除对应条目的 fields。 */
export function applyPendingClearsToProfile(
    profile: PromptBaseProfile | PromptDeltaProfile,
    pendingClears: Map<string, true>,
    name: string,
): void {
    const prefix = bufferPrefix(name);
    const ids = new Set<string>();
    for (const key of pendingClears.keys()) {
        if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
    }
    if (ids.size === 0) return;
    if (isPromptBaseProfile(profile)) {
        for (const p of profile.prompts) {
            if (ids.has(p.identifier)) delete p.fields;
        }
    } else {
        for (const c of profile.changes) {
            if (ids.has(c.identifier)) delete c.fields;
        }
    }
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

/** 撤销单个 reorder：把该条目移回打开时基线位置（initialOrderIndex），更新 reorderedIds。 */
export function undoReorderItem(ctx: EditorContext, identifier: string): void {
    const targetIdx = ctx.initialOrderIndex.get(identifier);
    if (targetIdx === undefined) return;
    const cur = ctx.sessionOrder.findIndex((o) => o.identifier === identifier);
    if (cur < 0) return;
    const [entry] = ctx.sessionOrder.splice(cur, 1);
    ctx.sessionOrder.splice(Math.min(targetIdx, ctx.sessionOrder.length), 0, entry);
    ctx.reorderedIds.delete(identifier);
}

/** 撤销 toggle + 值编辑（full undo）：还原 preset 与活动预设的运行时值，sessionOrder enabled 回退到 profile 解析值。 */
export function applyUndoState(ctx: EditorContext, key: string, identifier: string): void {
    ctx.pendingToggles.delete(key);
    const session = ctx.sessionEdits.get(key);
    if (session) {
        ctx.sessionEdits.delete(key);
        const preset = openai_settings[ctx.idx] as Preset;
        const prompt = findPromptInPreset(preset, identifier);
        if (prompt) {
            for (const f of PROMPT_FIELD_WHITELIST) {
                if (!(f in session.initial)) delete prompt[f];
            }
            Object.assign(prompt, session.initial);
        }
        if (oai_settings.preset_settings_openai === ctx.name) {
            const livePrompts = Array.isArray(oai_settings.prompts) ? oai_settings.prompts : [];
            const livePrompt = livePrompts.find((p: any) => p && p.identifier === identifier);
            if (livePrompt) {
                for (const f of PROMPT_FIELD_WHITELIST) {
                    if (!(f in session.initial)) delete livePrompt[f];
                }
                Object.assign(livePrompt, filterFields(session.initial));
            }
        }
    }
    // 开关撤销：sessionOrder enabled 回退到 profile 解析值（snapshot 不含 toggle 覆盖，仅 pendingMounts 覆盖）
    const snapshot = resolveEditorSnapshot(ctx);
    const view = snapshot?.entries.find((e) => e.identifier === identifier);
    if (view) {
        const soEntry = ctx.sessionOrder.find((o) => o.identifier === identifier);
        if (soEntry) soEntry.enabled = view.enabled;
    }
}

/** profile 解析态的挂载集合（identifier → mounted）：挂载净零检测与 staged mount 基线用（与 commit diff 语义一致）。 */
export function resolveProfileMountedMap(snapshot: EditorSnapshot): Map<string, boolean> {
    const resolved = resolveProfilePrompts(
        snapshot.profile,
        snapshot.meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[],
        new Set(),
    );
    return new Map(resolved.map((e) => [e.identifier, e.mounted]));
}

/** 开关净零参照：目标等于 profile 解析值 → 删缓冲；否则记录目标。返回是否产生了 toggle 缓冲。 */
export function resolveToggleNet(
    ctx: EditorContext,
    snapshot: EditorSnapshot | undefined,
    identifier: string,
    target: boolean,
): boolean {
    let resolvedEnabled: boolean | undefined;
    if (snapshot) {
        const resolved = resolveProfilePrompts(snapshot.profile, snapshot.meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[], new Set());
        resolvedEnabled = resolved.find((x) => x.identifier === identifier)?.enabled;
    }
    const key = bufferKey(ctx.name, identifier);
    if (resolvedEnabled === target) {
        ctx.pendingToggles.delete(key);
        return false;
    }
    ctx.pendingToggles.set(key, target);
    return true;
}

/** 拖拽重排的纯计算：基于会话 sessionOrder（不读不写 ST 的 prompt_order）。
 * 返回新 order 与脏标记变化。无变化返回 null。 */
export function computeReorder(
    ctx: EditorContext,
    domIds: string[],
): { order: { identifier: string; enabled: boolean }[]; dirtyChanges: { identifier: string; dirty: boolean }[] } | null {
    const order = ctx.sessionOrder;
    const inDom = new Set(domIds);
    const byId = new Map(order.map((o) => [o.identifier, o]));
    const newOrder = [
        ...domIds.map((id) => byId.get(id)).filter((o): o is { identifier: string; enabled: boolean } => !!o),
        ...order.filter((o) => !inDom.has(o.identifier)),
    ];
    if (newOrder.length === order.length && newOrder.every((o, i) => o.identifier === order[i].identifier)) return null;

    const newIndex = new Map(newOrder.map((o, i) => [o.identifier, i]));
    const dirtyChanges: { identifier: string; dirty: boolean }[] = [];
    for (const o of newOrder) {
        const dirtyNow = ctx.initialOrderIndex.get(o.identifier) !== newIndex.get(o.identifier);
        const wasDirty = ctx.reorderedIds.has(o.identifier);
        if (dirtyNow !== wasDirty) {
            dirtyChanges.push({ identifier: o.identifier, dirty: dirtyNow });
        }
    }
    return { order: newOrder, dirtyChanges };
}

/** reset 到父链 / 隐藏默认。共享核心见 profileMutators.resetProfileCore。返回 'reset' | 'no-default' | null。 */
export async function resetProfileToParent(ctx: EditorContext): Promise<'reset' | 'no-default' | null> {
    const preset = openai_settings[ctx.idx] as Preset;
    const meta = readMeta(preset);
    const profile = getProfile(meta, ctx.profileId);
    if (!profile) return null;
    if (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile)) return null;
    const result = await resetProfileCore(preset, meta, profile, ctx.name, ctx.idx);
    if (result === 'reset') ctx.refreshActivePresetUI(ctx.name);
    return result;
}

/** commit「更新当前配置」。返回是否成功。
 * opts.captureTopLevel：父预设是否为当前运行时（字段级流）。注册投影流下编辑器没有
 * 模型/采样 UI，父预设顶层值与编辑态无关，不得盖进 profile。 */
export async function commitUpdate(
    ctx: EditorContext,
    snapshot: { entries: PromptProfileEntry[]; unusedIds: string[] },
    opts?: { captureTopLevel?: boolean },
): Promise<boolean> {
    const editor = readEditableProfile(ctx);
    if (!editor) return false;
    const { meta, profile } = editor;
    const preset = openai_settings[ctx.idx] as Preset;
    // 副本上应用清除值变更：不直接改活 profile（失败回滚语义见 commitBufferedEditsToProfile）
    const nextProfile = structuredClone(profile);
    applyPendingClearsToProfile(nextProfile, ctx.pendingClears, ctx.name);
    if (opts?.captureTopLevel !== false) {
        const model = captureModel(preset);
        if (model) nextProfile.model = model;
        else delete nextProfile.model;
    }
    const ok = await commitBufferedEditsToProfile(nextProfile, snapshot, meta, ctx.name, ctx.idx, ctx.sessionEdits, 'full-changes');
    if (ok && opts?.captureTopLevel !== false) {
        // 字段级流（父预设=当前运行时）：持久化成功后把 sessionOrder 投影回预设（唯一写回点），
        // 再把缓冲写进运行时（此时=已提交态，天然一致）。注册投影流不写父预设——
        // 运行时刷新由 onMetaPersisted → syncPresetRegistrations → refreshProjectionRuntimeIfActive 闭环负责。
        projectSessionOrder(ctx);
        applyBufferedEdits(preset, ctx.name, ctx.sessionEdits, ctx.pendingToggles);
    }
    return ok;
}

/** commit「新建为子配置」。
 * opts.captureTopLevel：父预设是否为当前运行时（字段级流）。注册投影流下新 delta
 * 继承父链（不写 sampling/extra/model 键），不采集父预设顶层值。 */
export async function commitCreateDelta(
    ctx: EditorContext,
    deltaName: string,
    snapshot: { entries: PromptProfileEntry[]; unusedIds: string[] },
    opts?: { captureTopLevel?: boolean },
): Promise<void> {
    const editor = readEditableProfile(ctx);
    if (!editor) return;
    const { meta, profile } = editor;
    const preset = openai_settings[ctx.idx] as Preset;
    const profiles = Array.isArray(meta.profiles) ? meta.profiles : [];
    const parentEntries = resolveProfilePrompts(profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[], new Set());
    // previousChanges 传空：新建 delta 只存「相对父链解析状态」的净差异（本次快照 + 本次编辑），
    // 不冗余拷贝源 profile 已持久化的字段差异（否则数据膨胀/导出树冗余）。
    // unusedIds 传入以产出 unmount（mounted:false）change；顺序差异走 order（与 update 路径对称）。
    const deltaState = snapshotToDelta(snapshot.entries, parentEntries, snapshot.unusedIds);
    const changes = snapshotToChanges(snapshot.entries, parentEntries, [], snapshot.unusedIds);
    // sampling/extra 只存相对父链解析态的 sparse 差异（diff 为空不写）；注册投影流下不采集父预设顶层值
    const captureTopLevel = opts?.captureTopLevel !== false;
    const allProfiles = meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[];
    const samplingDiff = captureTopLevel
        ? diffSampling(captureSampling(preset), resolveEffectiveSampling(profile, allProfiles, meta.defaultSampling))
        : null;
    const extraDiff = captureTopLevel
        ? diffExtra(captureExtra(preset as Record<string, unknown>), resolveEffectiveExtra(profile, allProfiles, meta.defaultExtra))
        : null;
    // 先构建新 profiles（含 delta），持久化成功后才赋给 meta——saveMeta 失败重试不产生重复 delta。
    // 单向数据流：编辑期从未改过预设的 prompt_order，源预设落盘即为打开时状态，无需 clean-order 处理。
    const newProfiles = [...profiles, buildDerivedProfile(
        profile,
        deltaName,
        changes,
        samplingDiff ?? undefined,
        deltaState.order,
        captureTopLevel ? (captureModel(preset) ?? undefined) : undefined,
        extraDiff ?? undefined,
    )];
    recordDefaultOriginalFields(meta, ctx.name, ctx.sessionEdits);
    const nextMeta = { ...meta, profiles: newProfiles };
    const newDeltaId = String((newProfiles[newProfiles.length - 1] as PromptDeltaProfile).id);
    try {
        await saveMeta(ctx.name, ctx.idx, nextMeta);
    } catch (err) {
        // doSaveMeta 已在 fetch 前把含 delta 的 profiles 写进 preset.extensions；失败时回滚，
        // 否则「保留缓冲可重试」会 readMeta 读到含失败 delta 的数组而重复生成
        const ext = preset.extensions?.[EXTENSION_KEY];
        const extProfiles = ext?.profiles;
        if (ext && Array.isArray(extProfiles)) {
            ext.profiles = extProfiles.filter((p: any) => String(p?.id) !== newDeltaId);
        }
        throw err;
    }
    meta.profiles = newProfiles;
    toastr.success(L('Derived profile created'));
}

/** 读取可编辑的当前 profile（meta + profile），非 base/delta 时 toast 并返回 null。 */
export function readEditableProfile(ctx: EditorContext): { meta: PresetMeta; profile: PromptBaseProfile | PromptDeltaProfile } | null {
    const meta = readMeta(openai_settings[ctx.idx] as Preset);
    const profile = getProfile(meta, ctx.profileId);
    if (!profile || (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile))) {
        toastr.warning(L('This profile type cannot be edited with switches'));
        return null;
    }
    return { meta, profile };
}

/** 清空当前 name 的全部会话缓冲（含 pendingClears / pendingMounts / clearedEdits）：commit 消费后与关闭丢弃时共用。 */
export function clearSessionBuffers(ctx: EditorContext): void {
    clearBufferedForName(ctx.name, ctx.sessionEdits, ctx.pendingToggles);
    ctx.pendingClears.clear();
    for (const k of [...ctx.pendingMounts.keys()]) {
        if (k.startsWith(ctx.prefix)) ctx.pendingMounts.delete(k);
    }
    for (const k of [...ctx.unmountPositions.keys()]) {
        if (k.startsWith(ctx.prefix)) ctx.unmountPositions.delete(k);
    }
    for (const k of [...ctx.clearedEdits.keys()]) {
        if (k.startsWith(ctx.prefix)) ctx.clearedEdits.delete(k);
    }
}

/** 把会话 sessionOrder 投影回预设的 target prompt_order（仅在 commit 成功后调用；单向数据流的唯一写回点）。 */
export function projectSessionOrder(ctx: EditorContext): void {
    const preset = openai_settings[ctx.idx] as Preset;
    const targetId = resolvePromptOrderTarget();
    if (!Array.isArray(preset.prompt_order)) preset.prompt_order = [];
    let list = findOrderList(preset, targetId);
    if (!list) {
        list = { character_id: targetId, order: [] };
        preset.prompt_order.push(list);
    }
    list.order = ctx.sessionOrder.map((o) => ({ ...o }));
}

/** 撤销单个挂载操作：还原该条目在 sessionOrder 的挂载态，只动当前条目（不整表还原）。
 * target=true（用户挂载）→ 移除该条目；target=false（用户卸载）→ 加回该条目（卸载前原位）。 */
export function undoMount(ctx: EditorContext, key: string, identifier: string): void {
    const target = ctx.pendingMounts.get(key);
    ctx.pendingMounts.delete(key);

    if (target === true) {
        // 撤销挂载：从 sessionOrder 移除，并清理可能残留的 reorder 记录
        ctx.sessionOrder = ctx.sessionOrder.filter((o) => o.identifier !== identifier);
        ctx.reorderedIds.delete(identifier);
    } else if (target === false) {
        // 撤销卸载：优先按卸载时记录的原位插回（reorder 可能已改动位置）；无记录时按 initialOrder 相对位
        if (!ctx.sessionOrder.some((o) => o.identifier === identifier)) {
            const originalIdx = ctx.unmountPositions.get(key);
            if (originalIdx !== undefined && originalIdx >= 0 && originalIdx <= ctx.sessionOrder.length) {
                const original = ctx.initialOrder.find((o) => o.identifier === identifier);
                ctx.sessionOrder.splice(originalIdx, 0, { identifier, enabled: original?.enabled ?? true });
            } else {
                insertAtInitialPosition(ctx, identifier);
            }
        }
        ctx.unmountPositions.delete(key);
        ctx.reorderedIds.delete(identifier);
    }
}

/** 按弹窗打开时快照（initialOrder）的相对位置把条目插回 sessionOrder。
 * 插入点 = initialOrder 中位于该条目之前、且当前仍在 sessionOrder 的「最后一个前驱之后」的位置。
 * 不假设前驱在 current order 中连续（拖拽 reorder 后前驱可能被分散），逐个扫描取最后出现位。
 * fallbackEnabled：initialOrder 中无该条目（异常路径）时使用的 enabled，默认 true。 */
export function insertAtInitialPosition(ctx: EditorContext, identifier: string, fallbackEnabled = true): void {
    const original = ctx.initialOrder.find((o) => o.identifier === identifier);
    if (!original) {
        // 打开时不在初始 order（异常），退化为追加
        ctx.sessionOrder.push({ identifier, enabled: fallbackEnabled });
        return;
    }
    const beforeIds = new Set(
        ctx.initialOrder.slice(0, ctx.initialOrder.findIndex((o) => o.identifier === identifier))
            .map((o) => o.identifier),
    );
    // 插入点 = 最后一个存活前驱之后（前驱可能因 reorder 分散，取最后出现位置）
    let insertIdx = 0;
    for (let i = 0; i < ctx.sessionOrder.length; i++) {
        if (beforeIds.has(ctx.sessionOrder[i]?.identifier)) insertIdx = i + 1;
    }
    ctx.sessionOrder.splice(insertIdx, 0, { identifier, enabled: original.enabled });
}
