import { oai_settings, openai_settings } from '@sillytavern/scripts/openai';
import { EXTENSION_KEY } from './constants.js';
import { L } from './i18n.js';
import { getProfile, isPromptBaseProfile, isPromptDeltaProfile, readMeta, saveMeta } from './meta.js';
import type { Preset, PresetMeta, PromptBaseProfile, PromptDeltaProfile, PromptProfileEntry } from './meta.js';
import { bufferKey, bufferPrefix, clearBufferedForName, editedIdentifiersForName, type PromptEditBuffer } from './presetBuffers.js';
import type { ProfileEntryView } from './presetList.js';
import {
    PROMPT_FIELD_WHITELIST,
    buildPromptSnapshot,
    captureSampling,
    filterFields,
    findOrderList,
    findPromptInPreset,
    resolveProfilePrompts,
    resolvePromptOrderTarget,
    snapshotToChanges,
    snapshotToDelta,
} from './promptToggle.js';
import { commitBufferedEditsToProfile, recordDefaultOriginalFields } from './presetSnapshot.js';
import { buildDerivedProfile } from './profileActions.js';
import { resetProfileCore } from './profileMutators.js';
import { resolveEditorSnapshot, type EditorContext, type EditorSnapshot } from './profileEditorContext.js';

/** 右栏 staged diff 的一条字段变更。 */
export interface StagedFieldChange {
    label: string;
    from: string;
    to: string;
}

/** 右栏 staged diff 的一条记录。 */
export interface StagedItem {
    identifier: string;
    key: string;
    label: string;
    /** 条目在 prompt_order 中的序号（两位，同主列表显示），有则展示。 */
    index?: string;
    /** 主列表条目的完整展示数据（复用主列表卡片渲染）。 */
    entry?: ProfileEntryView;
    toggle?: { original: boolean; target: boolean };
    /** 挂载态变化：original 为 profile 当前挂载态，target 为目标挂载态（true=挂载 / false=卸载）。 */
    mount?: { original: boolean; target: boolean };
    fields: StagedFieldChange[];
    /** R1：本条目存在「清除值变更」待提交（commit 时删除 profile 快照 fields）。 */
    clear?: boolean;
    /** 顺序变化（reorder）：from=打开时 index，to=当前 index。位置改变统一由 index 比较判定，进 diff。 */
    reorder?: { from: number; to: number };
}

const FIELD_LABELS: Record<string, string> = {
    content: L('Content'),
    name: L('Name'),
    role: L('Role'),
    injection_position: L('Position'),
    injection_depth: L('Injection Depth'),
};

export function fmtValue(v: unknown): string {
    return v === undefined || v === null ? '' : String(v);
}

/** 采集当前缓冲（开关/值编辑）叠加后的快照——纯函数，不写运行时。
 * 构造临时视图 preset（浅克隆 prompts + 叠加 edited 字段与 toggle enabled），
 * 使 buildPromptSnapshot 采到与「提交后」一致的状态；运行时 prompts 保持未动。
 * 副作用（applyBufferedEdits 写真实 prompt/镜像）由调用方在 commit 成功后执行。 */
export function applyBufferedAndSnapshot(
    preset: Preset,
    name: string,
    sessionEdits: Map<string, PromptEditBuffer>,
    pendingToggles: Map<string, boolean>,
    pendingClears: Map<string, true>,
): { entries: PromptProfileEntry[]; unusedIds: string[] } {
    const prefix = bufferPrefix(name);
    // 临时视图：prompts 与目标 order 均浅克隆，叠加本会话的 toggle enabled（定义层 + order 条目）
    // 与字段 edited。运行时 prompts/order 保持未动。
    const view = {
        ...preset,
        prompts: Array.isArray(preset.prompts)
            ? preset.prompts.map((p: any) => ({ ...p }))
            : [],
        prompt_order: Array.isArray(preset.prompt_order)
            ? preset.prompt_order.map((list: any) => ({
                ...list,
                order: Array.isArray(list?.order) ? list.order.map((o: any) => ({ ...o })) : list?.order,
            }))
            : preset.prompt_order,
    };
    const viewById = new Map(view.prompts.map((p: any) => [p.identifier, p]));
    for (const [key, enabled] of pendingToggles) {
        if (!key.startsWith(prefix)) continue;
        const identifier = key.slice(prefix.length);
        const prompt = viewById.get(identifier);
        if (prompt) prompt.enabled = enabled;
        // 同步叠加目标 order 条目的 enabled（snapshotPromptState 优先读 order 条目）
        const orderList = findOrderList(view, resolvePromptOrderTarget());
        const orderEntry = Array.isArray(orderList?.order)
            ? orderList.order.find((o: any) => o?.identifier === identifier)
            : undefined;
        if (orderEntry) orderEntry.enabled = enabled;
    }
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
    for (const key of keys) {
        const identifier = key.slice(ctx.prefix.length);
        const entry = entryById.get(identifier);
        const item: StagedItem = { identifier, key, label: nameById.get(identifier) ?? identifier, index: entry?.index, entry, fields: [] };
        const rd = reorderDiff.get(identifier);
        if (rd) item.reorder = rd;
        const mountTarget = ctx.pendingMounts.get(key);
        if (mountTarget !== undefined) {
            // original = 会话初始挂载态（弹窗打开时快照），而非 !target（多翻转下语义才正确）
            const originalMounted = ctx.initialOrder.some((o) => o.identifier === identifier);
            item.mount = { original: originalMounted, target: mountTarget };
        }
        const toggleTarget = ctx.pendingToggles.get(key);
        if (toggleTarget !== undefined) {
            item.toggle = { original: enabledById.get(identifier) ?? true, target: toggleTarget };
        }
        const session = ctx.sessionEdits.get(key);
        if (session) {
            for (const field of PROMPT_FIELD_WHITELIST) {
                if (session.initial[field] !== session.edited[field]) {
                    item.fields.push({
                        label: FIELD_LABELS[field] ?? field,
                        from: fmtValue(session.initial[field]),
                        to: fmtValue(session.edited[field]),
                    });
                }
            }
        }
        // F2：clear 后重新编辑（session 存在）视为清除被覆盖，不渲染 clear 项
        if (ctx.pendingClears.has(key) && !session) {
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

/** 撤销 reorder 单条目：把该条目移回打开时基线位置（initialOrderIndex），更新 reorderedIds。 */
export function undoReorderItem(ctx: EditorContext, identifier: string): void {
    const preset = openai_settings[ctx.idx] as Preset;
    const list = findOrderList(preset, resolvePromptOrderTarget());
    if (!Array.isArray(list?.order)) return;
    const targetIdx = ctx.initialOrderIndex.get(identifier);
    if (targetIdx === undefined) return;
    const cur = list.order.findIndex((o: any) => o?.identifier === identifier);
    if (cur < 0) return;
    const [entry] = list.order.splice(cur, 1);
    list.order.splice(Math.min(targetIdx, list.order.length), 0, entry);
    ctx.reorderedIds.delete(identifier);
}

/** 在给定 order 上叠加本会话挂载缓冲：卸载条目移除，挂载条目插回（原位优先，无记录按 initialOrder 相对位）。
/** 撤销 toggle + 值编辑（full undo）：还原 preset 与活动预设的运行时值。 */
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

/** 拖拽重排的纯计算：返回新 order 与脏标记变化。无变化返回 null。 */
export function computeReorder(
    ctx: EditorContext,
    domIds: string[],
): { order: { identifier: string }[]; dirtyChanges: { identifier: string; dirty: boolean }[] } | null {
    const preset = openai_settings[ctx.idx] as Preset;
    const orderList = findOrderList(preset, resolvePromptOrderTarget());
    if (!orderList || !Array.isArray(orderList.order)) return null;

    const order = orderList.order as { identifier: string }[];
    const inDom = new Set(domIds);
    const byId = new Map(order.map((o) => [o.identifier, o]));
    const newOrder = [
        ...domIds.map((id) => byId.get(id)).filter((o): o is { identifier: string } => !!o),
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

/** commit「更新当前配置」。返回是否成功。 */
export async function commitUpdate(
    ctx: EditorContext,
    snapshot: { entries: PromptProfileEntry[]; unusedIds: string[] },
): Promise<boolean> {
    const editor = readEditableProfile(ctx);
    if (!editor) return false;
    const { meta, profile } = editor;
    // 副本上应用清除值变更：不直接改活 profile（失败回滚语义见 commitBufferedEditsToProfile）
    const nextProfile = structuredClone(profile);
    applyPendingClearsToProfile(nextProfile, ctx.pendingClears, ctx.name);
    return commitBufferedEditsToProfile(nextProfile, snapshot, meta, ctx.name, ctx.idx, ctx.sessionEdits, 'full-changes');
}

/** 计算「create-delta 应落盘的 order」：源预设还原到打开时快照（不含 reorder/挂载/卸载会话残留）。
 * reorder 现在进 diff（不即时落盘），随 create 快照进新 delta 的 order；源预设磁盘不应含任何会话改动。 */
function buildCommittedOrder(ctx: EditorContext, _list: any): { identifier: string; enabled: boolean }[] {
    return ctx.initialOrder.map((o) => ({ ...o }));
}

/** create-delta 专用保存：落盘前把运行时 order 临时换成「打开时快照」（源预设不含任何会话残留），POST 后恢复残留引用。
 * doSaveMeta 会 structuredClone 整个运行时 preset 落盘；若不处理，源预设 prompt_order 会残留
 * 本会话挂载/卸载/reorder（内存由 finalizeEditorSession 还原，磁盘不会——磁盘/内存分裂）。
 * reorder 与挂载一样进 diff：随 create 快照进新 delta 的 order，源预设磁盘还原到打开时快照。
 * finally 按引用回填残留：saveMeta 失败时运行时保持残留态，重试 commit 的 delta 数据不变。 */
async function saveMetaWithCleanOrder(ctx: EditorContext, meta: PresetMeta): Promise<void> {
    const preset = openai_settings[ctx.idx] as Preset;
    const dirtyList = findOrderList(preset, resolvePromptOrderTarget());
    const dirtyOrder = dirtyList?.order;
    const committed = buildCommittedOrder(ctx, dirtyList);
    if (dirtyList && Array.isArray(dirtyOrder)) {
        dirtyList.order = committed; // 临时换成 committed 视图（POST 体还原到打开时，不含会话残留）
    }
    try {
        await saveMeta(ctx.name, ctx.idx, meta);
    } finally {
        // 恢复残留：列表被移除时插回，order 引用原样回填（失败时运行时保持残留态供重试）
        if (dirtyList && !findOrderList(preset, resolvePromptOrderTarget())) {
            if (!Array.isArray(preset.prompt_order)) preset.prompt_order = [];
            preset.prompt_order.push(dirtyList);
        }
        if (dirtyList && Array.isArray(dirtyOrder)) dirtyList.order = dirtyOrder;
    }
}

/** commit「新建为子配置」。 */
export async function commitCreateDelta(
    ctx: EditorContext,
    deltaName: string,
    snapshot: { entries: PromptProfileEntry[]; unusedIds: string[] },
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
    // 先构建新 profiles（含 delta），持久化成功后才赋给 meta——saveMeta 失败重试不产生重复 delta
    const newProfiles = [...profiles, buildDerivedProfile(profile, deltaName, changes, captureSampling(preset) ?? undefined, deltaState.order)];
    recordDefaultOriginalFields(meta, ctx.name, ctx.sessionEdits);
    // saveMeta 持久化 nextMeta（含新 delta）；成功后把 profiles 同步回 meta 内存
    const nextMeta = { ...meta, profiles: newProfiles };
    const newDeltaId = String((newProfiles[newProfiles.length - 1] as PromptDeltaProfile).id);
    try {
        await saveMetaWithCleanOrder(ctx, nextMeta);
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

/** 清空当前 name 的全部会话缓冲（含 pendingClears / pendingMounts）：commit 消费后与关闭丢弃时共用。 */
export function clearSessionBuffers(ctx: EditorContext): void {
    clearBufferedForName(ctx.name, ctx.sessionEdits, ctx.pendingToggles);
    ctx.pendingClears.clear();
    for (const k of [...ctx.pendingMounts.keys()]) {
        if (k.startsWith(ctx.prefix)) ctx.pendingMounts.delete(k);
    }
    for (const k of [...ctx.unmountPositions.keys()]) {
        if (k.startsWith(ctx.prefix)) ctx.unmountPositions.delete(k);
    }
}

/** 未提交时还原内存 prompt_order 到弹窗打开时快照（挂载/卸载/顺序改动丢弃）。
 * 仅当本会话有挂载态或顺序改动（pendingMounts/reorderedIds 非空）才还原；否则不动。 */
export function restoreOrderIfUncommitted(ctx: EditorContext): void {
    const hasMountChanges = [...ctx.pendingMounts.keys()].some((k) => k.startsWith(ctx.prefix));
    if (!hasMountChanges && ctx.reorderedIds.size === 0) return;
    const preset = openai_settings[ctx.idx] as Preset;
    const list = findOrderList(preset, resolvePromptOrderTarget());
    if (Array.isArray(list?.order)) {
        list.order = ctx.initialOrder.map((o) => ({ ...o }));
    }
    // 本会话新建了目标 order 列表（initialOrder 为空快照）：还原后列表无意义，从 prompt_order 移除
    if (ctx.initialOrder.length === 0 && Array.isArray(preset.prompt_order)) {
        const targetId = resolvePromptOrderTarget();
        preset.prompt_order = preset.prompt_order.filter((l: any) => String(l?.character_id) !== String(targetId));
    }
}

/** 撤销单个挂载操作：还原该条目在 prompt_order 的挂载态，只动当前条目（不整表还原）。
 * target=true（用户挂载）→ 移除该条目；target=false（用户卸载）→ 加回该条目（卸载前原位）。 */
export function undoMount(ctx: EditorContext, key: string, identifier: string): void {
    const target = ctx.pendingMounts.get(key);
    ctx.pendingMounts.delete(key);
    const preset = openai_settings[ctx.idx] as Preset;
    const list = findOrderList(preset, resolvePromptOrderTarget());
    if (!Array.isArray(list?.order)) return;

    if (target === true) {
        // 撤销挂载：从 order 移除，并清理可能残留的 reorder 记录
        list.order = list.order.filter((o: any) => o?.identifier !== identifier);
        ctx.reorderedIds.delete(identifier);
    } else if (target === false) {
        // 撤销卸载：优先按卸载时记录的原位插回（reorder 可能已改动位置）；无记录时按 initialOrder 相对位
        if (!list.order.some((o: any) => o?.identifier === identifier)) {
            const originalIdx = ctx.unmountPositions.get(key);
            if (originalIdx !== undefined && originalIdx >= 0 && originalIdx <= list.order.length) {
                const original = ctx.initialOrder.find((o) => o.identifier === identifier);
                list.order.splice(originalIdx, 0, { identifier, enabled: original?.enabled ?? true });
            } else {
                insertAtInitialPosition(ctx, list, identifier);
            }
        }
        ctx.unmountPositions.delete(key);
        ctx.reorderedIds.delete(identifier);
    }
}

/** 按弹窗打开时快照（initialOrder）的相对位置把条目插回目标 order。
 * 插入点 = initialOrder 中位于该条目之前、且当前仍在 order 的「最后一个前驱之后」的位置。
 * 不假设前驱在 current order 中连续（拖拽 reorder 后前驱可能被分散），逐个扫描取最后出现位。
 * fallbackEnabled：initialOrder 中无该条目（异常路径）时使用的 enabled，默认 true。 */
export function insertAtInitialPosition(ctx: EditorContext, list: any, identifier: string, fallbackEnabled = true): void {
    const original = ctx.initialOrder.find((o) => o.identifier === identifier);
    if (!original) {
        // 打开时不在初始 order（异常），退化为追加
        list.order.push({ identifier, enabled: fallbackEnabled });
        return;
    }
    const beforeIds = new Set(
        ctx.initialOrder.slice(0, ctx.initialOrder.findIndex((o) => o.identifier === identifier))
            .map((o) => o.identifier),
    );
    // 插入点 = 最后一个存活前驱之后（前驱可能因 reorder 分散，取最后出现位置）
    let insertIdx = 0;
    for (let i = 0; i < list.order.length; i++) {
        if (beforeIds.has(list.order[i]?.identifier)) insertIdx = i + 1;
    }
    list.order.splice(insertIdx, 0, { identifier, enabled: original.enabled });
}
