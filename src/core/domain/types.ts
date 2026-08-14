// core/domain：零 ST 依赖的领域类型（Phase 1 codec 第一步）。
// 这些类型描述 profile / prompt 快照的数据形状，与 ST 全局、DOM、持久化无关。
// 上层从 './meta.js' re-export 以保持既有调用点不变；逐步把实现逻辑也下沉到 core。

/** prompt 值字段（全可选，向后兼容旧数据）。白名单见 PROMPT_FIELD_WHITELIST。 */
export interface PromptFields {
    content?: string;
    name?: string;
    role?: string;
    injection_position?: number;
    injection_depth?: number;
}

/** 采样参数快照（全可选）：缺失的键在加载 profile 时保持预设当前值，不覆盖。
 * 键与 SAMPLING_KEYS 一一对应（temperature/top_p/top_k/top_a/min_p/frequency_penalty/
 * presence_penalty/repetition_penalty/seed/n/openai_max_context/openai_max_tokens/stream_openai）。 */
export interface PromptSampling {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    top_a?: number;
    min_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    repetition_penalty?: number;
    seed?: number;
    n?: number;
    openai_max_context?: number;
    openai_max_tokens?: number;
    stream_openai?: boolean;
}

/** profile 绑定的模型（chat_completion_source + 对应模型键值）。加载 profile 时一并应用。 */
export interface PromptModel {
    source: string;
    name: string;
}

/** v3 prompt 条目：挂载态（mounted）+ 开关 + 值字段差异。 */
export interface PromptProfileEntry {
    identifier: string;
    mounted: boolean;
    enabled: boolean;
    lastActiveIndex?: number;
    fields?: PromptFields;
}

/** v3 delta 的一条差异：挂载/开关/顺序/值字段差异。 */
export interface PromptStateChange {
    identifier: string;
    mounted?: boolean;
    enabled?: boolean;
    lastActiveIndex?: number;
    fields?: PromptFields;
}

/** 主 profile（formatVersion 3）：记录当前目标 prompt_order 的完整挂载状态 + 值字段。
 * 是 v2（formatVersion 2）的超集：v2 数据仅记录 mounted 开关，v3 增补 unused/顺序。 */
export interface PromptBaseProfile {
    formatVersion: 3;
    kind: 'prompt_base';
    id: string;
    name: string;
    prompts: PromptProfileEntry[];
    /** 保存时未挂载（在 prompts 定义中但不在目标 prompt_order）的 identifier。只记 id，不存无意义字段。 */
    unusedIds?: string[];
    /** 采样参数差异（可选）：仅存「相对出厂基线有差异」的键；加载时叠加到出厂基线（defaultSampling）。 */
    sampling?: PromptSampling;
    /** 附加快照差异（可选）：仅存「相对出厂基线有差异」的预设键（如 impersonation_prompt、bias_preset_selected 等）。
     * 加载时叠加到出厂基线（defaultExtra）并 Object.assign 还原到预设（保留 extensions）。 */
    extra?: Record<string, any>;
    /** 创建/更新时记录的模型快照；加载 profile 时沿父链解析并应用（链上无记录时回退出厂基线 defaultModel）。 */
    model?: PromptModel;
}

/** 派生 profile 的一条差异：挂载/开关/顺序/值字段差异（与 PromptStateChange 同构的兼容别名）。
 * v3 下 delta 的 changes 实际为 PromptStateChange[]（含 mounted/lastActiveIndex），
 * 此类型用于兼容既有 PromptDeltaChange[] 调用点。 */
export interface PromptDeltaChange {
    identifier: string;
    mounted?: boolean;
    enabled?: boolean;
    lastActiveIndex?: number;
    fields?: Record<string, any>;
}

/** 派生 profile（formatVersion 3）：相对主 profile 的差异，加载时「主 + 子」叠加应用。 */
export interface PromptDeltaProfile {
    formatVersion: 3;
    kind: 'prompt_delta';
    id: string;
    name: string;
    baseId: string;
    changes: PromptStateChange[];
    /** 完整的 mounted identifier 顺序；缺省表示继承父级顺序。 */
    order?: string[];
    /** 采样参数差异（可选）：仅存相对父链解析态有差异的键；加载时沿父链从出厂基线依次叠加。 */
    sampling?: PromptSampling;
    /** 附加快照差异（可选）：仅存相对父链解析态有差异的键；加载时沿父链从出厂基线依次叠加。 */
    extra?: Record<string, any>;
    /** 创建/更新时记录的模型快照；加载 profile 时沿父链解析并应用（链上无记录时回退出厂基线 defaultModel）。 */
    model?: PromptModel;
}

/** defaultSnapshot 条目：出厂基线（首次 add base 时锁定）。挂载态 + 开关 + 原始值字段。 */
export interface PromptDefaultSnapshotEntry {
    identifier: string;
    mounted: boolean;
    enabled: boolean;
    lastActiveIndex?: number;
    originalFields?: PromptFields;
}

/** v3 profile 联合类型（base / delta）。 */
export type PresetProfile = PromptBaseProfile | PromptDeltaProfile;

/**
 * v4 完整 preset 快照：结构化克隆的 preset 本体 + 其他扩展，
 * 但不含 `extensions['preset_cards']`（插件容器/特征值不是用户预设运行状态）。
 */
export interface PresetSnapshot {
    name?: string;
    prompts?: any[];
    prompt_order?: any[];
    extensions?: Record<string, any>;
    [key: string]: any;
}

/** v4 profile 节点：全量快照 + parentId 树 + 相对 root/父节点的差异集。 */
export interface V4ProfileNode {
    id: string;
    name: string;
    parentId?: string;
    presetSnapshot: PresetSnapshot;
    diff?: unknown;
}

/** v4 preset-cards.json 文件对象（一组 preset 的唯一权威文件）。 */
export interface PresetCardsFile {
    version: 4;
    presets: { key: string; name?: string; profileIds: string[] }[];
    nodes: V4ProfileNode[];
}

