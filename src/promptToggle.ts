import { oai_settings, promptManager, settingsToUpdate } from '@sillytavern/scripts/openai';
import { L } from './i18n.js';
import { isPromptBaseProfile, isPromptDeltaProfile } from './meta.js';
import type { Preset, PresetProfile, PromptBaseProfile, PromptDefaultSnapshotEntry, PromptDeltaChange, PromptDeltaProfile, PromptFields, PromptSampling } from './meta.js';
import { SAMPLING_KEYS } from './constants.js';

/** 允许写入预设的值字段白名单；capture/apply 只处理这些键（R10 白名单兜底）。
 * injection_position / injection_depth 为用户可编辑字段，随 profile 捕获/应用
 * （injection_depth 支持 profile-editor 弹窗的注入深度编辑）；
 * order 仍为内部字段，UI 不编辑、不随 profile 捕获，
 * 否则加载 profile 时会用旧快照覆盖用户此后在 Prompt Manager 里调整的注入值。 */
export const PROMPT_FIELD_WHITELIST: (keyof PromptFields)[] = [
    'content',
    'name',
    'role',
    'injection_position',
    'injection_depth',
];

/** 两个 PromptFields 是否逐白名单字段一致（用于判断编辑是否有净变化）。 */
export function promptFieldsEqual(a: PromptFields, b: PromptFields): boolean {
    return PROMPT_FIELD_WHITELIST.every((key) => a[key] === b[key]);
}

/** 采集预设当前的采样参数快照（SAMPLING_KEYS 全部键，值非 undefined 才写入）；无任何键时返回 null。
 * 返回 null 而非空对象，便于调用点统一「非空才持久化 sampling」（避免落盘 sampling:{} 噪声）。 */
export function captureSampling(preset: Preset): PromptSampling | null {
    const sampling: PromptSampling = {};
    for (const key of SAMPLING_KEYS) {
        const value = (preset as Record<string, unknown>)[key];
        if (value !== undefined) {
            (sampling as Record<string, unknown>)[key] = value;
        }
    }
    return Object.keys(sampling).length > 0 ? sampling : null;
}

/** 应用采样参数快照到预设：只写 sampling 中存在的键，缺失键保持预设当前值（不动）。 */
export function applySampling(preset: Preset, sampling: PromptSampling): void {
    const target = preset as Record<string, unknown>;
    for (const key of SAMPLING_KEYS) {
        const value = (sampling as Record<string, unknown>)[key];
        if (value !== undefined) target[key] = value;
    }
}

/** 采样键与忽略键之外、应排除出 extra 快照的键（prompt 主体在 prompts 数组/order 处理）。
 * 连接/凭据键（ST settingsToUpdate 标记 is_connection=true：模型、来源、代理、endpoint 等）一律排除——
 * 它们是「用户当前连接状态」而非 profile 快照内容，reset 不应把模型/凭据回退出厂。 */
const EXTRA_EXCLUDED_KEYS = new Set([
    'prompts',
    'prompt_order',
    'extensions',
    'name',
    ...Object.keys(settingsToUpdate).filter((key) => settingsToUpdate[key]?.[3] === true),
]);

/** 采集「v1 存了但 v2 无结构对应」的附加快照：settings 中除采样键、prompts/prompt_order/extensions/name、连接键外的其余键。
 * 用于 v1→v2 迁移时保留旧版预设的附加 prompt 设置（impersonation_prompt、bias_preset_selected 等）。
 * 空结果返回 null（调用点统一「非空才写」）。 */
export function captureExtra(settings: Record<string, unknown>): Record<string, any> | null {
    const extra: Record<string, any> = {};
    for (const [key, value] of Object.entries(settings)) {
        if (SAMPLING_KEYS.some((k) => k === key)) continue;
        if (EXTRA_EXCLUDED_KEYS.has(key)) continue;
        extra[key] = value;
    }
    return Object.keys(extra).length > 0 ? extra : null;
}

/** 应用附加快照到预设：Object.assign 还原（保留 extensions）；只写 extra 中存在的键。 */
export function applyExtra(preset: Preset, extra: Record<string, any>): void {
    const ext = preset.extensions;
    Object.assign(preset, extra);
    preset.extensions = ext;
}

/**
 * 采集单个 prompt 的值字段（仅白名单键，跳过 undefined）。
 * 纯读取，不修改 preset。
 */
export function capturePromptFields(prompt: Record<string, any> | undefined): PromptFields {
    const fields: PromptFields = {};
    if (!prompt) return fields;
    for (const key of PROMPT_FIELD_WHITELIST) {
        const value = prompt[key];
        if (value !== undefined) {
            fields[key] = value;
        }
    }
    return fields;
}

/** 只保留白名单键的值字段（R10：应用边界防御，丢弃导入/旧数据里的任意键）。 */
export function filterFields(fields: Record<string, any> | undefined): PromptFields {
    const out: PromptFields = {};
    if (!fields) return out;
    for (const key of PROMPT_FIELD_WHITELIST) {
        if (fields[key] !== undefined) out[key] = fields[key];
    }
    return out;
}

/**
 * R2 镜像 hack（必要 ST workaround，勿删）：若编辑的是当前激活预设，
 * 同步值字段到运行时的 oai_settings.prompts：生成时 promptManager 读的就是这个对象
 * （openai.js:1557），不依赖异步的 #settings_preset_openai 刷新；同时让
 * 「以当前设置覆盖」不再有旧值可回退覆盖（R2：#update_oai_preset →
 * getChatCompletionPreset(oai_settings) 会把存盘预设覆盖成 oai_settings 的旧快照，
 * 导致本编辑被抹掉）。
 */
export function mirrorFieldsToActivePreset(presetName: string, identifier: string, fields: PromptFields): void {
    if (oai_settings.preset_settings_openai !== presetName) return;
    const livePrompts = Array.isArray(oai_settings.prompts) ? oai_settings.prompts : [];
    const livePrompt = livePrompts.find((p: any) => p && p.identifier === identifier);
    if (livePrompt) {
        Object.assign(livePrompt, filterFields(fields));
    }
}

/** 在预设中按 identifier 查找 prompt（Array.isArray 守卫兼容旧对象格式）。 */
export function findPromptInPreset(preset: Preset, identifier: string): any | undefined {
    const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    return prompts.find((p: any) => p && p.identifier === identifier);
}

/**
 * 单条开关应用到预设实际值：改 prompts[].enabled 并同步 prompt_order。
 * 返回是否匹配到该 identifier。
 */
export function applyEntryState(preset: Preset, identifier: string, enabled: boolean): boolean {
    const prompt = findPromptInPreset(preset, identifier);
    if (!prompt) return false;

    prompt.enabled = enabled;
    syncPromptOrder(preset, [{ identifier, enabled }]);
    return true;
}

/**
 * 读取 prompt_order 中指定 character 条目的运行时真值；缺失时回退 prompts[].enabled，再缺失默认 true。
 * 未指定 characterId 时使用 global 条目（100001），保持 reset 默认基线的既有语义。
 * R5：修复默认预设常缺 prompts[].enabled 键、快照把全部 prompt 记成禁用的问题。
 * 只读，不改写入侧。
 */
export function runtimeEnabledFor(
    prompt: { identifier: string; enabled?: boolean },
    preset: Preset,
    characterId: number | string = 100001,
): boolean {
    const orderEnabled = promptOrderEnabledFor(preset, prompt.identifier, characterId);
    if (orderEnabled !== undefined) return orderEnabled;
    return prompt.enabled ?? true;
}

/** 只读取 prompt_order 中明确保存的开关；缺失表示 unused/未知，不做定义层回退。 */
export function promptOrderEnabledFor(
    preset: Preset,
    identifier: string,
    characterId: number | string = 100001,
): boolean | undefined {
    const list = Array.isArray(preset.prompt_order)
        ? preset.prompt_order.find((x: any) => x && String(x.character_id) === String(characterId))
        : undefined;
    if (Array.isArray(list?.order)) {
        const order = list.order.find((o: any) => o && o.identifier === identifier);
        if (order && typeof order.enabled === 'boolean') {
            return order.enabled;
        }
    }
    return undefined;
}

/**
 * 全量锁定快照：全部 prompts 采集白名单值字段；仅 global order 中 mounted 的 prompt 保存 enabled。
 * unused 的 enabled 保持未知，reset 时不修改其开关。
 * 作为 reset 的出厂基线（lockDefaultSnapshot 用），区别于仅开关的开关快照。
 */
export function buildDefaultSnapshotLock(preset: Preset): PromptDefaultSnapshotEntry[] {
    if (!Array.isArray(preset.prompts)) return [];
    return preset.prompts
        .filter((p: any) => p && typeof p.identifier === 'string' && p.identifier)
        .map((p: any) => {
            const enabled = promptOrderEnabledFor(preset, p.identifier);
            return {
                identifier: p.identifier,
                ...(enabled !== undefined ? { enabled } : {}),
                originalFields: capturePromptFields(p),
            };
        });
}

/**
 * 按 identifier 回写 preset.prompts[].enabled 并同步 prompt_order；
 * 主 profile 若带 fields 则叠加值字段（仅 enabled 覆盖，值编辑不影响开关）。
 */
export function applyBaseProfile(preset: Preset, profile: PromptBaseProfile): void {
    const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    const byIdentifier = new Map<string, any>(
        prompts.filter((p: any) => p && typeof p.identifier === 'string' && p.identifier).map((p: any) => [p.identifier, p]),
    );

    const orderEntries: { identifier: string; enabled: boolean }[] = [];
    for (const entry of profile.prompts) {
        const prompt = byIdentifier.get(entry.identifier);
        if (!prompt) continue;
        prompt.enabled = entry.enabled;
        if (entry.fields) {
            Object.assign(prompt, filterFields(entry.fields));
        }
        orderEntries.push({ identifier: entry.identifier, enabled: entry.enabled });
    }

    if (orderEntries.length > 0) {
        syncPromptOrder(preset, orderEntries);
    }

    if (profile.sampling) {
        applySampling(preset, profile.sampling);
    }
    if (profile.extra) {
        applyExtra(preset, profile.extra);
    }
}

/**
 * 解析 delta 的直接父 profile（按 baseId 查找，递归走完父链）的有效开关状态。
 * 父缺失或为 v1 快照（无法作为差异基线）时返回空数组。
 */
export function resolveParentStates(
    profile: PromptDeltaProfile,
    allProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
): { identifier: string; enabled: boolean; fields?: PromptFields }[] {
    const parent = allProfiles.find((p) => p.id === profile.baseId);
    if (!parent) return [];
    return resolveProfilePrompts(parent, allProfiles);
}

/**
 * 递归解析一个 profile 的完整开关 + 值字段状态（含 fields）：
 * - base：直接返回 prompts（含 fields）；
 * - delta：先解析 parent（base 或上层 delta），再叠加 changes（enabled 覆盖 + fields 合并）。
 * 共用递归 + seen 防环骨架，额外聚合 fields。
 */
export function resolveProfilePrompts(
    profile: PromptBaseProfile | PromptDeltaProfile,
    allProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
    seen: Set<string> = new Set(),
): { identifier: string; enabled: boolean; fields?: PromptFields }[] {
    if (!profile || seen.has(profile.id)) return [];
    seen.add(profile.id);

    if (isPromptBaseProfile(profile)) {
        return structuredClone(profile.prompts);
    }

    // 非 delta（如 v1 全量快照或未知类型）无父链可解析，安全返回空，绝不抛错
    if (!isPromptDeltaProfile(profile)) {
        return [];
    }

    const parent = allProfiles.find((p) => p.id === profile.baseId);
    const entries = parent ? resolveProfilePrompts(parent, allProfiles, seen) : [];

    const map = new Map<string, { identifier: string; enabled: boolean; fields?: PromptFields }>();
    for (const entry of entries) {
        map.set(entry.identifier, {
            identifier: entry.identifier,
            enabled: entry.enabled,
            fields: entry.fields ? { ...entry.fields } : undefined,
        });
    }

    for (const change of profile.changes) {
        const existing = map.get(change.identifier);
        if (existing) {
            if (change.enabled !== undefined) {
                existing.enabled = change.enabled;
            }
            if (change.fields) {
                existing.fields = Object.assign({}, existing.fields, change.fields);
            }
        } else if (change.enabled !== undefined) {
            map.set(change.identifier, {
                identifier: change.identifier,
                enabled: change.enabled,
                fields: change.fields ? { ...change.fields } : undefined,
            });
        }
    }

    return [...map.values()];
}

/**
 * 应用派生 profile：先应用主 profile 的全部开关，再叠加差异（enabled 覆盖 + fields 合并），
 * 同步 prompt_order。返回匹配计数与缺失 identifier 列表。
 */
export function applyDeltaProfile(
    preset: Preset,
    delta: PromptDeltaProfile,
    base: PromptBaseProfile | undefined,
): { matched: number; missing: string[] } {
    if (base) {
        applyBaseProfile(preset, base);
    }

    const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    const byIdentifier = new Map<string, any>(
        prompts.filter((p: any) => p && typeof p.identifier === 'string' && p.identifier).map((p: any) => [p.identifier, p]),
    );

    const orderEntries: { identifier: string; enabled: boolean }[] = [];
    const missing: string[] = [];
    let matched = 0;

    for (const change of delta.changes) {
        const prompt = byIdentifier.get(change.identifier);
        if (!prompt) {
            missing.push(change.identifier);
            continue;
        }

        if (change.enabled !== undefined) {
            prompt.enabled = change.enabled;
        }
        if (change.fields) {
            Object.assign(prompt, filterFields(change.fields));
        }

        orderEntries.push({ identifier: change.identifier, enabled: !!prompt.enabled });
        matched++;
    }

    if (orderEntries.length > 0) {
        syncPromptOrder(preset, orderEntries);
    }

    if (delta.sampling) {
        applySampling(preset, delta.sampling);
    }
    if (delta.extra) {
        applyExtra(preset, delta.extra);
    }

    return { matched, missing };
}

/**
 * 在 preset.prompt_order 中查找指定 character_id 的条目。
 * Array.isArray 守卫兼容旧对象格式 {character_id: {order}}（否则 .find 会抛 TypeError）。
 */
export function findOrderList(preset: Preset, characterId: number | string): any {
    if (!Array.isArray(preset.prompt_order)) return undefined;
    return preset.prompt_order.find((x: any) => x && String(x.character_id) === String(characterId));
}

/** 清理目标策略 prompt_order 列表里引用已不存在 prompt 的孤儿条目（ST 删除 prompt 后残留）。
 * 仅清目标策略列表（与 syncPromptOrder 一致），避免影响其他角色的 order。 */
export function pruneStaleOrderEntries(preset: Preset): void {
    if (!Array.isArray(preset.prompts)) return;
    const list = findOrderList(preset, resolvePromptOrderTarget());
    if (!list?.order || !Array.isArray(list.order)) return;
    const validIds = new Set<string>();
    for (const p of preset.prompts) {
        if (p && typeof p.identifier === 'string' && p.identifier) validIds.add(p.identifier);
    }
    const filtered = list.order.filter((o: any) => o && validIds.has(o.identifier));
    if (filtered.length !== list.order.length) {
        list.order = filtered;
    }
}

/**
 * 读取 prompt_order 的写入目标角色 id（策略感知）：
 * - global（默认）→ 100001（ST dummyId，作用于所有角色）；
 * - character → promptManager.activeCharacter.id（ST PromptManager.js:1130-1144 维护；
 *   新角色无 order 条目时 ST 会写默认顺序，按 100001 写的数据对该角色「看似消失」）。
 * promptManager 缺失 / 目标角色缺失时回退 100001，绝不抛错。
 */
export function resolvePromptOrderTarget(): number {
    const strategy = promptManager?.configuration?.promptOrder?.strategy;
    if (strategy === 'character') {
        return promptManager?.activeCharacter?.id ?? 100001;
    }
    return 100001;
}

/**
 * 同步 preset.prompt_order 中目标策略条目（global → 100001 / character → 活动角色 id）的开关。
 * 对应条目的 order 数组仅按 identifier 更新已存在条目的 enabled；缺失条目保持 unused，不自动挂载。
 * Array.isArray 守卫兼容旧对象格式 {character_id: {order}}（否则 .find 会抛 TypeError）。
 */
export function syncPromptOrder(
    preset: Preset,
    entries: { identifier: string; enabled: boolean }[],
): void {
    const list = findOrderList(preset, resolvePromptOrderTarget());
    if (!Array.isArray(list?.order)) return;

    for (const entry of entries) {
        const existing = list.order.find((o: any) => o?.identifier === entry.identifier);
        if (existing) {
            existing.enabled = entry.enabled;
        }
    }
}

/** 当前目标 prompt_order.order 中存在的 prompt identifier。 */
function promptOrderIdentifiers(preset: Preset): Set<string> {
    const list = findOrderList(preset, resolvePromptOrderTarget());
    if (!Array.isArray(list?.order)) return new Set();
    return new Set(
        list.order
            .filter((entry: any) => entry && typeof entry.identifier === 'string' && entry.identifier)
            .map((entry: any) => entry.identifier),
    );
}

/**
 * 采集当前目标 prompt_order.order 中 prompts 的开关 + 可选值字段快照。
 * 过滤逻辑与开关快照共用；enabled 用当前目标 order 的 runtimeEnabledFor。
 * includeFields 含某 identifier 时附带 fields: capturePromptFields(prompt)。
 */
export function buildPromptSnapshot(
    preset: Preset,
    opts?: { includeFields?: Set<string> },
): { identifier: string; enabled: boolean; fields?: PromptFields }[] {
    if (!Array.isArray(preset.prompts)) return [];
    const orderIdentifiers = promptOrderIdentifiers(preset);
    return preset.prompts
        .filter((p: any) => p && typeof p.identifier === 'string' && orderIdentifiers.has(p.identifier))
        .map((p: any) => {
            const entry: { identifier: string; enabled: boolean; fields?: PromptFields } = {
                identifier: p.identifier,
                enabled: runtimeEnabledFor(p, preset, resolvePromptOrderTarget()),
            };
            if (opts?.includeFields?.has(p.identifier)) {
                entry.fields = capturePromptFields(p);
            }
            return entry;
        });
}

/**
 * 基于锁定基线的 base 快照（add base 用）：
 * enabled 只采集当前目标 prompt_order.order 中的 prompt；fields 只存「与基线 originalFields 有差异的白名单字段」。
 * - 基线缺失的条目（新增 prompt 等）fields 全量写入；
 * - 与基线一致的条目不写 fields（加载时保持基线/当前值）。
 * 相比仅开关的快照，此快照让 add base 保留 content 差异，又避免全量 content 几百 KB。
 * baseline 传 null/undefined（或全无条目）时退化为「开关+全量 fields」快照（兼容旧数据）。
 */
export function buildBaseSnapshotDiff(
    preset: Preset,
    baseline: PromptDefaultSnapshotEntry[] | null | undefined,
): { identifier: string; enabled: boolean; fields?: PromptFields }[] {
    if (!Array.isArray(preset.prompts)) return [];
    const orderIdentifiers = promptOrderIdentifiers(preset);
    const baselineFields = new Map<string, PromptFields>();
    if (Array.isArray(baseline)) {
        for (const entry of baseline) {
            if (entry.originalFields) baselineFields.set(entry.identifier, entry.originalFields);
        }
    }
    return preset.prompts
        .filter((p: any) => p && typeof p.identifier === 'string' && orderIdentifiers.has(p.identifier))
        .map((p: any) => {
            const entry: { identifier: string; enabled: boolean; fields?: PromptFields } = {
                identifier: p.identifier,
                enabled: runtimeEnabledFor(p, preset, resolvePromptOrderTarget()),
            };
            const current = capturePromptFields(p);
            const base = baselineFields.get(p.identifier);
            if (base) {
                const diff: Record<string, any> = {};
                let hasDiff = false;
                for (const key of PROMPT_FIELD_WHITELIST) {
                    if (current[key] !== undefined && current[key] !== base[key]) {
                        diff[key] = current[key];
                        hasDiff = true;
                    }
                }
                if (hasDiff) entry.fields = filterFields(diff);
            } else if (Object.keys(current).length > 0) {
                entry.fields = current;
            }
            return entry;
        });
}

/**
 * 从快照生成派生差异（含值差异）：
 * - enabled：与 parent 解析后的完整状态逐条对比（纯开关差异）；
 * - fields：逐条白名单字段，仅当快照值 ≠ 父链解析值才写入；等于父值 → 不写（即清除）；
 * - previousChanges.fields 对未编辑的 identifier 原样保留，已编辑的 identifier 重建（覆盖旧差异）。
 */
export function snapshotToChanges(
    snapshot: { identifier: string; enabled: boolean; fields?: PromptFields }[],
    parentEntries: { identifier: string; enabled: boolean; fields?: PromptFields }[],
    previousChanges: PromptDeltaChange[] = [],
): PromptDeltaChange[] {
    const baseEnabled = new Map(parentEntries.map((p) => [p.identifier, p.enabled]));
    const baseFields = new Map(parentEntries.map((p) => [p.identifier, p.fields]));
    const previousFields = new Map(
        previousChanges.filter((c) => c.fields).map((c) => [c.identifier, c.fields]),
    );

    const changes: PromptDeltaChange[] = [];
    for (const state of snapshot) {
        const baseValue = baseEnabled.get(state.identifier);
        const enabledDiff = baseValue !== undefined && baseValue !== state.enabled;

        const base = baseFields.get(state.identifier);
        let fieldDiff: PromptFields | undefined;
        if (state.fields) {
            const diff: Record<string, any> = {};
            let hasDiff = false;
            for (const key of PROMPT_FIELD_WHITELIST) {
                const snapValue = state.fields[key];
                const baseValueField = base?.[key];
                if (snapValue !== undefined && snapValue !== baseValueField) {
                    diff[key] = snapValue;
                    hasDiff = true;
                }
            }
            if (hasDiff) fieldDiff = diff;
        }
        const fields = state.fields !== undefined ? fieldDiff : previousFields.get(state.identifier);

        if (enabledDiff || fields) {
            const change: PromptDeltaChange = { identifier: state.identifier };
            if (enabledDiff) change.enabled = state.enabled;
            if (fields) change.fields = fields;
            changes.push(change);
        }
    }

    return changes;
}

/** 加载配置的核心分支（base / delta / v1），两种加载入口共用。
 * 差异由调用方处理：delta 的「缺失 prompt 已跳过」toast 仅卡片点击加载时显示（showMissingToast）；
 * v1 的 refresh 时机不同（简洁模式走 refreshActivePresetUI，卡片点击走条件性原生刷新）。
 * 注意：本函数含 UI 通知副作用（内部直接 toastr.warning，文案经 L() 取 i18n），非纯逻辑；
 * 这也是 promptToggle 依赖 ./i18n.js（L）的原因（依赖方向无环、可接受）。 */
export function applyProfileToPreset(
    preset: Preset,
    profile: PresetProfile,
    allProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
    opts?: { showMissingToast?: boolean },
): void {
    pruneStaleOrderEntries(preset);

    if (isPromptBaseProfile(profile)) {
        applyBaseProfile(preset, profile);
    } else if (isPromptDeltaProfile(profile)) {
        const states = resolveProfilePrompts(profile, allProfiles);
        if (states.length === 0) {
            toastr.warning(L('Base profile not found, applying changes only'));
        } else {
            applyBaseProfile(preset, {
                formatVersion: 2,
                kind: 'prompt_base',
                id: profile.baseId || 'parent',
                name: 'Parent',
                prompts: states,
            });
        }
        const { missing } = applyDeltaProfile(preset, profile, undefined);
        if (opts?.showMissingToast && missing.length > 0) {
            toastr.warning(`${L('Missing prompts skipped')}: ${missing.join(', ')}`);
        }
    } else {
        // v1 全量快照：合并 settings，保留 extensions
        const ext = preset.extensions;
        Object.assign(preset, profile.settings);
        preset.extensions = ext;
    }
}
