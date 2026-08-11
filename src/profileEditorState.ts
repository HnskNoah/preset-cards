import { oai_settings, openai_settings } from '@sillytavern/scripts/openai';
import { L } from './i18n.js';
import { getProfile, isPromptBaseProfile, isPromptDeltaProfile, readMeta, saveMeta } from './meta.js';
import type { Preset, PresetMeta, PromptBaseProfile, PromptDeltaProfile, PromptProfileEntry } from './meta.js';
import { applyBufferedEdits, bufferKey, bufferPrefix, clearBufferedForName, editedIdentifiersForName, type PromptEditBuffer } from './presetBuffers.js';
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
    toggle?: { original: boolean; target: boolean };
    fields: StagedFieldChange[];
    /** R1：本条目存在「清除值变更」待提交（commit 时删除 profile 快照 fields）。 */
    clear?: boolean;
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

/** 统一应用本会话的开关/值编辑缓冲并采集快照：缺失条目提示跳过。 */
export function applyBufferedAndSnapshot(
    preset: Preset,
    name: string,
    sessionEdits: Map<string, PromptEditBuffer>,
    pendingToggles: Map<string, boolean>,
    pendingClears: Map<string, true>,
): { entries: PromptProfileEntry[]; unusedIds: string[] } {
    const missing = applyBufferedEdits(preset, name, sessionEdits, pendingToggles);
    if (missing.length > 0) {
        toastr.warning(`${L('Missing prompts skipped')}: ${missing.join(', ')}`);
    }
    const include = editedIdentifiersForName(name, sessionEdits);
    const prefix = bufferPrefix(name);
    for (const key of pendingClears.keys()) {
        if (key.startsWith(prefix)) include.add(key.slice(prefix.length));
    }
    const snapshot = buildPromptSnapshot(preset, { includeFields: include });
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
    const enabledById = new Map(resolved.entries.map((e) => [e.identifier, e.enabled]));

    const keys = new Set<string>();
    for (const k of ctx.pendingToggles.keys()) if (k.startsWith(ctx.prefix)) keys.add(k);
    for (const k of ctx.sessionEdits.keys()) if (k.startsWith(ctx.prefix)) keys.add(k);
    for (const k of ctx.pendingClears.keys()) if (k.startsWith(ctx.prefix)) keys.add(k);

    const items: StagedItem[] = [];
    for (const key of keys) {
        const identifier = key.slice(ctx.prefix.length);
        const item: StagedItem = { identifier, key, label: nameById.get(identifier) ?? identifier, fields: [] };
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
    applyPendingClearsToProfile(profile, ctx.pendingClears, ctx.name);
    return commitBufferedEditsToProfile(profile, snapshot, meta, ctx.name, ctx.idx, ctx.sessionEdits, 'full-changes');
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
    profiles.push(buildDerivedProfile(profile, deltaName, changes, captureSampling(preset) ?? undefined, deltaState.order));
    meta.profiles = profiles;
    recordDefaultOriginalFields(meta, ctx.name, ctx.sessionEdits);
    await saveMeta(ctx.name, ctx.idx, meta);
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

/** 清空当前 name 的全部会话缓冲（含 pendingClears）：commit 消费后与关闭丢弃时共用。 */
export function clearSessionBuffers(ctx: EditorContext): void {
    clearBufferedForName(ctx.name, ctx.sessionEdits, ctx.pendingToggles);
    ctx.pendingClears.clear();
}
