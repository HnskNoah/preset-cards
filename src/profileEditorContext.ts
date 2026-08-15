import { Popup } from '@sillytavern/scripts/popup';
import { openai_settings } from '@sillytavern/scripts/openai';
import { getProfile, isPromptBaseProfile, isPromptDeltaProfile, readMeta } from './meta.js';
import type { Preset, PresetMeta, PromptBaseProfile, PromptDeltaProfile } from './meta.js';
import { bufferKey, bufferPrefix, type PromptEditBuffer } from './presetBuffers.js';
import { findOrderList, resolvePromptOrderTarget } from './promptToggle.js';
import { buildOrderCtxFromOrder, buildProfileEntries, type ProfileEntryView, type ProfileOrderCtx } from './presetList.js';
import type { EditorStore } from './core/store/EditorStore.js';


/** 弹窗依赖：缓冲 Map 与刷新回调由 presetCards 闭包注入。 */
export interface ProfileEditorDeps {
    sessionEdits: Map<string, PromptEditBuffer>;
    pendingToggles: Map<string, boolean>;
    refreshActivePresetUI: (presetName: string) => void;
    /** 保存后刷新卡片网格。 */
    onGridRefresh: () => Promise<void>;
}

/** 当前 profile 的一次解析快照（每次读取最新内存态）。 */
export interface EditorSnapshot {
    preset: Preset;
    meta: PresetMeta;
    profile: PromptBaseProfile | PromptDeltaProfile;
    entries: ProfileEntryView[];
    orderCtx: ProfileOrderCtx;
    readOnly: boolean;
}

/** profile-editor 弹窗的共享状态（替代巨型函数裸闭包捕获）。 */
export interface EditorContext {
    // 注入依赖（来自 ProfileEditorDeps，只读）
    sessionEdits: Map<string, PromptEditBuffer>;
    pendingToggles: Map<string, boolean>;
    refreshActivePresetUI: (presetName: string) => void;
    onGridRefresh: () => Promise<void>;
    // 入参（只读）
    name: string;
    idx: number;
    profileId: string;
    prefix: string;
    // DOM（元素身份必须稳定，render 只 empty().append() 不重建）
    dialog: JQuery<HTMLElement>;
    popup?: Popup;
    // 会话可变状态
    searchQuery: string;
    searchIndex: Map<string, { name: string; content: string }>;
    /** 搜索防抖定时器（input 连续输入时延迟执行过滤）。 */
    searchTimer?: ReturnType<typeof setTimeout>;
    editTargetId: string | null;
    mobileShowRight: boolean;
    listLocked: boolean;
    reorderedIds: Set<string>;
    pendingClears: Map<string, true>;
    /** 本会话挂载态变更缓冲：identifier → 目标 mounted 态（true=挂载 / false=卸载）。Commit 才写 profile。 */
    pendingMounts: Map<string, boolean>;
    /** 本会话卸载条目在 order 中的原位置（卸载时记录，undo 撤销卸载时插回原位；reorder 可能已改动位置）。 */
    unmountPositions: Map<string, number>;
    initialOrderIndex: Map<string, number>;
    /** 弹窗打开时目标 prompt_order 完整快照：reorder 差异基线 + 挂载净零判定 + 插回位置依据。 */
    initialOrder: { identifier: string; enabled: boolean }[];
    /** 会话内工作顺序（唯一真值源）：挂载/卸载/拖拽只改这里，commit 成功后才投影回预设的 prompt_order。 */
    sessionOrder: { identifier: string; enabled: boolean }[];
    /** 提交/重置进行中标志（防 re-entrancy：快速连点不二次进入）。 */
    committing: boolean;
    /** clear 时快照的会话编辑（undo clear 时恢复：session 恢复 + toggle 恢复）。 */
    clearedEdits: Map<string, { session?: PromptEditBuffer; toggle?: boolean }>;
    /** P4：编辑器会话 store（staged diff 单一来源，逐步接管现状 Map/闭包）。 */
    editorStore?: EditorStore;
}

/** 创建弹窗上下文：完成全部状态初始化（含打开时 prompt_order 快照与 sessionOrder 种子）。 */
export function createEditorContext(
    deps: ProfileEditorDeps,
    name: string,
    idx: number,
    profileId: string,
): EditorContext {
    const preset = openai_settings[idx] as Preset;
    // 弹窗打开时目标 prompt_order 完整快照（还原/基线用）
    const list = findOrderList(preset, resolvePromptOrderTarget());
    const initialOrder: { identifier: string; enabled: boolean }[] = Array.isArray(list?.order)
        ? list.order
            .filter((o: any) => o && typeof o.identifier === 'string')
            .map((o: any) => ({ identifier: o.identifier, enabled: o.enabled === true }))
        : [];
    return {
        ...deps,
        name,
        idx,
        profileId,
        prefix: bufferPrefix(name),
        dialog: $('<div id="preset_profile_editor" class="pc-manager-container"></div>'),
        searchQuery: '',
        searchIndex: new Map(),
        editTargetId: null,
        mobileShowRight: false,
        listLocked: false,
        reorderedIds: new Set<string>(),
        pendingClears: new Map<string, true>(),
        pendingMounts: new Map<string, boolean>(),
        unmountPositions: new Map<string, number>(),
        initialOrderIndex: buildOrderCtxFromOrder(initialOrder).orderIndex,
        initialOrder,
        sessionOrder: initialOrder.map((o) => ({ ...o })),
        committing: false,
        clearedEdits: new Map(),
    };
}

/** 读取当前预设/元数据/profile 解析后的展示条目（每次调用取最新内存态）。
 * 顺序以会话 sessionOrder 为准（单向数据流：编辑期不改 ST 的 prompt_order）；
 * mounted 态叠加会话挂载缓冲（pendingMounts）：激活/卸载即时反映在展示分组。 */
export function resolveEditorSnapshot(ctx: EditorContext): EditorSnapshot | undefined {
    const preset = openai_settings[ctx.idx] as Preset;
    const meta = readMeta(preset);
    const profile = getProfile(meta, ctx.profileId);
    if (!profile || (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile))) return undefined;
    const orderCtx = buildOrderCtxFromOrder(ctx.sessionOrder);
    const entries = buildProfileEntries(profile, meta, preset, orderCtx).map((e) => {
        const mountTarget = ctx.pendingMounts.get(bufferKey(ctx.name, e.identifier));
        if (mountTarget !== undefined) {
            e.mounted = mountTarget;
            // 挂载后 enabled 取 sessionOrder（与提交快照一致），否则刚挂载条目仍显示 Off
            if (mountTarget) {
                const so = ctx.sessionOrder.find((o) => o.identifier === e.identifier);
                if (so) e.enabled = so.enabled;
            }
        }
        return e;
    });
    return {
        preset,
        meta,
        profile,
        entries,
        orderCtx,
        readOnly: false,
    };
}

/** 面包屑的一项：节点名 + 是否当前节点。 */
export interface BreadcrumbItem {
    name: string;
    isCurrent: boolean;
}

/** 非当前节点名字压缩为「开头 + …」（当前节点完整显示）。 */
export function truncateBreadcrumbName(name: string, max: number): string {
    if (!name) return '';
    return name.length > max ? name.slice(0, max) + '…' : name;
}

// 构建三段式面包屑「父 ▸ 当前 ▸ 子」：父取祖先链的两端（最祖先 + 最近父，中间层级折叠省略），
// 子取当前节点第一个直接派生（meta.profiles 中 baseId 指向当前 id 的 delta）。无父/无子则对应段省略。
// 非当前节点名字压缩为「开头 + …」（TRUNCATE_MAX），当前节点完整显示。
// title 保留完整派生链（全部祖先 ▸ 当前 ▸ 子），hover 时不丢信息。
// 防环：visited 记录已访问 id，成环数据不致死循环。
const TRUNCATE_MAX = 12;

export function buildBreadcrumb(profile: PromptBaseProfile | PromptDeltaProfile, meta: PresetMeta): { items: BreadcrumbItem[]; title: string } {
    const chain: { name: string; id: string }[] = [];
    const visited = new Set<string>();
    let current: { name: string; id: string } = { name: profile.name, id: String(profile.id) };
    while (!visited.has(current.id)) {
        visited.add(current.id);
        chain.unshift(current);
        if (chain.length > 50) break; // 硬上限，防御极端损坏数据
        // 当前节点若是 delta，沿 baseId 向上找父；base 或父缺失/非 base/delta 即到根
        const node = getProfile(meta, current.id);
        if (!node || !isPromptDeltaProfile(node)) break;
        const parent = getProfile(meta, node.baseId);
        if (!parent || (!isPromptBaseProfile(parent) && !isPromptDeltaProfile(parent))) break;
        current = { name: parent.name, id: String(parent.id) };
    }

    const ancestors = chain.slice(0, -1);
    const rootAncestor = ancestors.length > 0 ? ancestors[0] : undefined; // 最祖先
    const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1] : undefined; // 最近父
    const hasIntermediate = ancestors.length > 2; // 两端之间有被折叠的中间层
    const child = (Array.isArray(meta.profiles) ? meta.profiles : []).find(
        (candidate) => isPromptDeltaProfile(candidate) && String(candidate.baseId) === String(profile.id),
    );
    const childName = child ? child.name : undefined;

    const title = [
        ...ancestors.map((item) => item.name),
        profile.name,
        ...(childName ? [childName] : []),
    ].join(' ▸ ');

    const items: BreadcrumbItem[] = [];
    if (rootAncestor) {
        items.push({ name: truncateBreadcrumbName(rootAncestor.name, TRUNCATE_MAX), isCurrent: false });
        if (hasIntermediate) items.push({ name: '…', isCurrent: false });
        if (parent && parent.id !== rootAncestor.id) {
            items.push({ name: truncateBreadcrumbName(parent.name, TRUNCATE_MAX), isCurrent: false });
        }
    } else if (parent) {
        items.push({ name: truncateBreadcrumbName(parent.name, TRUNCATE_MAX), isCurrent: false });
    }
    items.push({ name: profile.name, isCurrent: true });
    if (childName) items.push({ name: truncateBreadcrumbName(childName, TRUNCATE_MAX), isCurrent: false });
    return { items, title };
}
