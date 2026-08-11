import { oai_settings, openai_settings, openai_setting_names } from '@sillytavern/scripts/openai';
import { AVAILABLE_MODELS, LOGO_BASE, MODEL_KEYS, SOURCE_LABELS, SOURCE_LOGO_MAP } from './constants.js';
import { isPromptBaseProfile, isPromptDeltaProfile, readMeta, type Preset, type PresetMeta, type PresetProfile, type PromptBaseProfile, type PromptDeltaProfile } from './meta.js';
import { findOrderList, resolveProfilePrompts, resolvePromptOrderTarget } from './promptToggle.js';
import { getActiveProfile } from './activeProfile.js';
import { L } from './i18n.js';
import { buildProfileForest, buildProfileNested, type NestedProfileNode } from './profileTree.js';

export interface ModelChip {
    label: string;
    logo: string;
}

/** profile 展开后展示的一个条目（prompt 名 + 开关状态）。 */
export interface ProfileEntryView {
    identifier: string;
    name: string;
    enabled: boolean;
    /** 该条目的角色（profile 覆盖值优先，否则预设原值，缺省 system），仅展示用。 */
    role?: string;
    /** 顺序序号（1-based，两位显示），仅活动预设且条目在目标 prompt_order 中时有值。 */
    index?: string;
    /** 该条目的当前正文（profile 解析 fields 或预设运行时值），仅用于搜索过滤，模板不渲染正文。 */
    content?: string;
    hasFields?: boolean;
    /** 本 profile 自身存有的持久差异（base 看 prompts[].fields；delta 看自身 changes 的 fields 或 enabled 开关差异）。 */
    hasPersistentDiff?: boolean;
    /** 是否本 profile 自身存有该条目的值差异（base 看 fields；delta 看自身 changes），可清除。 */
    clearable?: boolean;
    /** 是否允许编辑内容：仅普通 prompt（非 system_prompt / marker）可编辑。 */
    editable?: boolean;
    /** 是否允许开关（enabled）：对齐 ST PromptManager 的 isPromptToggleAllowed——普通 prompt 均可开关，
     * marker 条目仅 ST forceTogglePrompts 白名单内的可开关（如 charDescription/chatHistory/dialogueExamples）。 */
    toggleable?: boolean;
    /** 是否允许顺序编辑（仅活动预设、且目标 prompt_order 条目的 order 含该 identifier）。 */
    orderable?: boolean;
}

/** 单张卡片的视图模型,喂给 cards.html 模板。 */
export interface PresetCardModel {
    name: string;
    index: number;
    isActive: boolean;
    temperature: string;
    topP: string;
    topK: string;
    contextTokens: number;
    maxTokens: number;
    streaming: boolean;
    sourceAndModel: string;
    logoPath: string;
    description: string;
    bgImage: string;
    modelChips: ModelChip[];
    profiles: ProfileNode[];
}

/** 单条 profile 的卡片行视图模型（含递归 children，供分组折叠渲染）。 */
export interface ProfileRow {
    id: string;
    name: string;
    isV1: boolean;
    depth: number;
    entries: ProfileEntryView[];
    isActiveProfile: boolean;
    childCount: number;
}

export interface ProfileNode extends ProfileRow {
    children: ProfileNode[];
}

function truncate(str: string, max: number): string {
    if (!str) return '';
    return str.length > max ? '…' + str.slice(-(max - 1)) : str;
}

/** 顺序编辑上下文：目标 prompt_order 条目的顺序索引与长度（仅活动预设有效）。 */
export interface ProfileOrderCtx {
    orderIndex: Map<string, number>;
    orderLength: number;
}

/** 构建顺序编辑上下文：global → 100001；character → 活动角色 id（策略感知）。
 * 非活动预设返回空上下文（顺序编辑仅对活动预设开放）。 */
export function buildProfileOrderCtx(preset: Preset, isActive: boolean): ProfileOrderCtx {
    const orderIndex = new Map<string, number>();
    let orderLength = 0;
    if (isActive && Array.isArray(preset.prompt_order)) {
        const orderList = findOrderList(preset, resolvePromptOrderTarget());
        if (Array.isArray(orderList?.order)) {
            orderLength = orderList.order.length;
            orderList.order.forEach((o: any, i: number) => {
                if (o && typeof o.identifier === 'string') orderIndex.set(o.identifier, i);
            });
        }
    }
    return { orderIndex, orderLength };
}

/** ST PromptManager 的 marker 条目开关白名单（forceTogglePrompts）：这些 marker 内容虽由 ST 管理，
 * 但原生允许用户开关其启用状态，我们的编辑器同样放开开关。 */
const FORCE_TOGGLE_MARKERS = new Set([
    'charDescription',
    'charPersonality',
    'scenario',
    'personaDescription',
    'worldInfoBefore',
    'worldInfoAfter',
    'main',
    'chatHistory',
    'dialogueExamples',
]);

/** 构建单个 profile 的展示条目列表（卡片与 profile-editor 弹窗共用）。
 * 展示 = 递归解析 parent 链的完整开关 + 值字段；name/content 供弹窗搜索。 */
export function buildProfileEntries(
    profile: PresetProfile,
    meta: PresetMeta,
    preset: Preset,
    orderCtx: ProfileOrderCtx = { orderIndex: new Map(), orderLength: 0 },
): ProfileEntryView[] {
    if (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile)) return [];

    const promptNames = new Map<string, string>();
    const promptLookup = new Map<string, any>();
    if (Array.isArray(preset.prompts)) {
        for (const p of preset.prompts) {
            if (p && typeof p.identifier === 'string' && p.identifier) {
                promptLookup.set(p.identifier, p);
                if (typeof p.name === 'string') {
                    promptNames.set(p.identifier, p.name);
                }
            }
        }
    }

    const resolved = resolveProfilePrompts(profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[], new Set());
    // 按 prompt_order 的 orderIndex 排序展示（active 预设 orderCtx 已建）：已知序排前，未知 identifier 保持原相对顺序排后
    const sorted = [...resolved].sort((a, b) => {
        const ia = orderCtx.orderIndex.get(a.identifier);
        const ib = orderCtx.orderIndex.get(b.identifier);
        if (ia !== undefined && ib !== undefined) return ia - ib;
        if (ia !== undefined) return -1;
        if (ib !== undefined) return 1;
        return 0;
    });
    return sorted.map((e) => {
        const prompt = promptLookup.get(e.identifier);
        const hasFields = !!e.fields && Object.keys(e.fields).length > 0;
        const orderIdx = orderCtx.orderIndex.get(e.identifier);
        return {
            identifier: e.identifier,
            name: e.fields?.name ?? promptNames.get(e.identifier) ?? e.identifier,
            role: e.fields?.role ?? prompt?.role ?? 'system',
            index: orderIdx !== undefined ? String(orderIdx + 1).padStart(2, '0') : undefined,
            content: e.fields?.content ?? prompt?.content,
            enabled: e.enabled,
            hasFields,
            // hasFields 基于 resolveProfilePrompts（递归合并父链）→ 含继承自父 profile 的 fields；
            // hasPersistentDiff 仅本 profile 自身差异：base 取自身 prompts[].fields（= hasFields），
            // delta 取自身 changes 里的 fields/enabled，父链继承的差异不属于本 profile。
            // 故「子 delta 有继承值差异 → 有铅笔（hasFields）无琥珀（hasPersistentDiff）」为预期行为。
            hasPersistentDiff: isPromptDeltaProfile(profile)
                ? profile.changes.some((c) => c.identifier === e.identifier
                    && (c.enabled !== undefined || (c.fields && Object.keys(c.fields).length > 0)))
                : hasFields,
            // base 的 fields 即自身值变更；delta 需自身 changes 里有 fields（父链继承的不可由本 profile 清除）
            clearable: isPromptDeltaProfile(profile)
                ? profile.changes.some((c) => c.identifier === e.identifier && c.fields && Object.keys(c.fields).length > 0)
                : hasFields,
            // system_prompt / marker 条目不渲染编辑入口；预设中缺失的条目也无法编辑
            editable: !!prompt && !prompt.system_prompt && !prompt.marker,
            // 开关对齐 ST isPromptToggleAllowed：普通 prompt 均可开关；marker 仅白名单内的可开关
            toggleable: !!prompt && (!prompt.marker || FORCE_TOGGLE_MARKERS.has(prompt.identifier)),
            // 顺序编辑仅对活动预设开放（重排非活动预设的 prompt_order 无意义）
            orderable: orderIdx !== undefined,
        };
    });
}

/**
 * Build the template-friendly preset list.
 */
export function buildPresetList(): PresetCardModel[] {
    const currentPresetName = oai_settings.preset_settings_openai;
    const presets: PresetCardModel[] = [];
    const activeRef = getActiveProfile();

    for (const [name, index] of Object.entries(openai_setting_names)) {
        const preset = openai_settings[index] as Preset | undefined;
        if (!preset) continue;

        const isActive = name === currentPresetName;

        // 顺序编辑目标条目：global → 100001；character → 活动角色 id（策略感知，见 promptToggle）。
        const orderCtx = buildProfileOrderCtx(preset, isActive);

        const source = String(preset['chat_completion_source'] ?? '');
        const sourceLabel = SOURCE_LABELS[source] || '';
        const modelKey = MODEL_KEYS[source] || '';
        const modelName = modelKey ? truncate(String(preset[modelKey] ?? ''), 40) : '';

        // Source + model combined line
        let sourceAndModel = sourceLabel;
        if (modelName) sourceAndModel += ' · ' + modelName;

        // Logo: use source logo if available
        const logoPath = SOURCE_LOGO_MAP[source] || '';

        // Read custom metadata
        const meta = readMeta(preset);

        // Decorate each profile node: base/delta 徽章、derive 按钮、可展开条目列表。
        // 派生关系按嵌套树组织（base/delta 每级独立折叠），depth 表达层级。
        const decorate = (node: NestedProfileNode): ProfileNode => {
            const p = node.profile;
            let entries: ProfileEntryView[] = [];
            if (isPromptBaseProfile(p) || isPromptDeltaProfile(p)) {
                // 展示 = 递归解析 parent 链的完整开关 + 值字段（base 与 delta 统一走 buildProfileEntries）
                entries = buildProfileEntries(p, meta, preset, orderCtx);
            }
            const row: ProfileRow = {
                id: String(p.id),
                name: p.name,
                isV1: !isPromptBaseProfile(p) && !isPromptDeltaProfile(p),
                depth: node.depth,
                entries,
                isActiveProfile: !!activeRef && activeRef.presetName === name && activeRef.profileId === String(p.id),
                childCount: node.children.length,
            };
            return { ...row, children: node.children.map(decorate) };
        };
        const forest = buildProfileForest(Array.isArray(meta.profiles) ? meta.profiles : []);
        const profiles: ProfileNode[] = buildProfileNested(forest).map(decorate);

        // Build model chips from metadata
        const modelChips = meta.models.map(mid => {
            const def = AVAILABLE_MODELS.find(m => m.id === mid);
            return def ? { label: def.label, logo: LOGO_BASE + def.logo } : { label: mid, logo: '' };
        });

        presets.push({
            name,
            index,
            isActive,
            temperature: preset['temperature'] != null ? String(preset['temperature']) : '',
            topP: preset['top_p'] != null ? String(preset['top_p']) : '',
            topK: preset['top_k'] != null ? String(preset['top_k']) : '',
            contextTokens: Number(preset['openai_max_context'] || 0),
            maxTokens: Number(preset['openai_max_tokens'] || 0),
            streaming: !!preset['stream_openai'],
            sourceAndModel,
            logoPath,
            description: meta.description,
            bgImage: meta.bgImage,
            modelChips,
            profiles,
        });
    }

    // Active first, then alphabetically
    presets.sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    return presets;
}

export function getCardsTemplateContext() {
    return {
        presets: buildPresetList(),
        i18n: {
            searchPlaceholder: L('Search presets...'),
            multiSelect: L('Multi-Select'),
            batchDelete: L('Batch Delete'),
            importPreset: L('Import Preset'),
            conciseMode: L('Concise Mode'),
            clearCache: L('Clear Cache'),
            configurations: L('Configurations'),
            addBaseConfig: L('Save Base Profile'),
            loadConfig: L('Load configuration'),
            exportConfig: L('Export configuration'),
            importConfig: L('Import configuration'),
            exportAll: L('Export all configurations'),
            edit: L('Edit'),
            delete: L('Delete'),
            derive: L('Derive Profile'),
            resetProfile: L('Reset to parent'),
        }
    };
}
