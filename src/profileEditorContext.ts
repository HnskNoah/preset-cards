import { Popup } from '@sillytavern/scripts/popup';
import { oai_settings, openai_settings } from '@sillytavern/scripts/openai';
import { getProfile, isPromptBaseProfile, isPromptDeltaProfile, readMeta } from './meta.js';
import type { Preset, PresetMeta, PromptBaseProfile, PromptDeltaProfile } from './meta.js';
import { bufferPrefix, type PromptEditBuffer } from './presetBuffers.js';
import { buildProfileEntries, buildProfileOrderCtx, type ProfileEntryView, type ProfileOrderCtx } from './presetList.js';
import { isArchiveProfile } from './profileActions.js';

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
    editTargetId: string | null;
    mobileShowRight: boolean;
    listLocked: boolean;
    reorderedIds: Set<string>;
    pendingClears: Map<string, true>;
    initialOrderIndex: Map<string, number>;
}

/** 创建弹窗上下文：完成全部状态初始化（含打开时 prompt_order 快照）。 */
export function createEditorContext(
    deps: ProfileEditorDeps,
    name: string,
    idx: number,
    profileId: string,
): EditorContext {
    const initialOrderIndex = buildProfileOrderCtx(
        openai_settings[idx] as Preset,
        oai_settings.preset_settings_openai === name,
    ).orderIndex;
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
        initialOrderIndex,
    };
}

/** 读取当前预设/元数据/profile 解析后的展示条目（每次调用取最新内存态）。 */
export function resolveEditorSnapshot(ctx: EditorContext): EditorSnapshot | undefined {
    const preset = openai_settings[ctx.idx] as Preset;
    const meta = readMeta(preset);
    const profile = getProfile(meta, ctx.profileId);
    if (!profile || (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile))) return undefined;
    const isActive = oai_settings.preset_settings_openai === ctx.name;
    const orderCtx = buildProfileOrderCtx(preset, isActive);
    return {
        preset,
        meta,
        profile,
        entries: buildProfileEntries(profile, meta, preset, orderCtx),
        orderCtx,
        readOnly: isArchiveProfile(profile as PromptBaseProfile),
    };
}

/** 面包屑的一项：节点名 + 是否当前节点。 */
export interface BreadcrumbItem {
    name: string;
    isCurrent: boolean;
}

// 构建三段式面包屑「父 ▸ 当前 ▸ 子」：父取当前节点直接上级（沿 baseId 链向上收集，取最近一个），
// 子取当前节点第一个直接派生（meta.profiles 中 baseId 指向当前 id 的 delta）。无父/无子则对应段省略。
// title 保留完整派生链（全部祖先 ▸ 当前 ▸ 子），hover 时不丢信息。
// 防环：visited 记录已访问 id，成环数据不致死循环。
export function buildBreadcrumb(profile: PromptBaseProfile | PromptDeltaProfile, meta: PresetMeta): { items: BreadcrumbItem[]; title: string } {
    const chain: { name: string; id: string }[] = [];
    const visited = new Set<string>();
    let current: { name: string; id: string } = { name: profile.name, id: String(profile.id) };
    while (!visited.has(current.id)) {
        visited.add(current.id);
        chain.unshift(current);
        if (chain.length > 50) break; // 硬上限，防御极端损坏数据
        // 当前节点若是 delta，沿 baseId 向上找父；base/v1 或父缺失/非 base/delta 即到根
        const node = getProfile(meta, current.id);
        if (!node || !isPromptDeltaProfile(node)) break;
        const parent = getProfile(meta, node.baseId);
        if (!parent || (!isPromptBaseProfile(parent) && !isPromptDeltaProfile(parent))) break;
        current = { name: parent.name, id: String(parent.id) };
    }

    const ancestors = chain.slice(0, -1);
    const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1] : undefined;
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
    if (parent) items.push({ name: parent.name, isCurrent: false });
    items.push({ name: profile.name, isCurrent: true });
    if (childName) items.push({ name: childName, isCurrent: false });
    return { items, title };
}
