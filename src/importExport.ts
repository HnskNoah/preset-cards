import { POPUP_TYPE, callGenericPopup } from '@sillytavern/scripts/popup';
import { EXTENSION_KEY } from './constants.js';
import { L } from './i18n.js';
import { stableStringify } from './stableStringify.js';
import {
    isPromptBaseProfile,
    isPromptDeltaProfile,
    newProfileId,
    type PresetMeta,
    type PresetProfile,
    type PromptBaseProfile,
    type PromptDeltaProfile,
    type PromptProfileEntry,
} from './meta.js';
import { makeBaseProfile, makeDeltaProfile } from './profileActions.js';
import { assertV3ImportPayload, LegacyProfileFormatError } from './profileSchema.js';
export function chooseProfileSaveTarget(): Promise<'update' | 'create' | null> {
    return chooseFromOptions(L('Save changes to'), [
        [L('Update current profile'), 'update'],
        [L('Create new subprofile'), 'create'],
    ]);
}

// 通用选项弹窗：标题 + 若干操作按钮 + 取消，返回所选操作或 null
export async function chooseFromOptions<T extends string>(title: string, options: [label: string, value: T][]): Promise<T | null> {
    const container = $('<div class="preset_cards_save_choice"></div>');
    container.append($('<div class="preset_cards_save_choice_title"></div>').text(title));
    const buttons = $('<div class="preset_cards_save_choice_actions"></div>');
    for (const [label, value] of options) {
        buttons.append($('<button class="menu_button"></button>')
            .text(label)
            .on('click', function () { resolveChoice(value); }));
    }
    buttons.append($('<button class="menu_button"></button>')
        .text(L('Cancel'))
        .on('click', function () { resolveChoice(null); }));
    container.append(buttons);

    let resolver: (v: T | null) => void;
    let settled = false;
    const promise = new Promise<T | null>(r => { resolver = r; });

    function resolveChoice(v: T | null): void {
        if (settled) return;
        settled = true;
        resolver(v);
        $(container).closest('.popup').find('.popup-controls .menu_button').click();
    }

    callGenericPopup(container, POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: '',
        onClose: () => {
            if (!settled) {
                settled = true;
                resolver(null);
            }
        },
    });
    return promise;
}

// 从完整 preset 导出文件（exportPresetFile 产物，含 extensions['preset_cards']）中提取 profiles。
// 返回数组（可能为空 = 该 preset 无 profiles）；非完整 preset 载荷（v3 base/delta/prompt_tree 或普通 ST 预设）返回 undefined。
export function extractProfilesFromPresetExport(parsed: Record<string, unknown>): (PromptBaseProfile | PromptDeltaProfile)[] | undefined {
    if (parsed?.kind === 'prompt_base' || parsed?.kind === 'prompt_delta' || parsed?.kind === 'prompt_tree') {
        return undefined;
    }
    const ext = (parsed?.extensions ?? {}) as Record<string, unknown>;
    const presetCards = ext[EXTENSION_KEY] && typeof ext[EXTENSION_KEY] === 'object'
        ? (ext[EXTENSION_KEY] as Record<string, unknown>)
        : undefined;
    if (!presetCards) return undefined;
    const rawProfiles = presetCards.profiles;
    if (!Array.isArray(rawProfiles)) return undefined;
    return rawProfiles.filter((p): p is PromptBaseProfile | PromptDeltaProfile =>
        isPromptBaseProfile(p) || isPromptDeltaProfile(p));
}

// 稳定序列化已下沉 stableStringify.ts（捕获侧净零比较共用）

/**
 * profile 内容指纹：排除 id / name / baseId（跨导入随机 id 重映射后仍可比较）。
 * delta 用「父节点指纹」代替 baseId——同一差异挂在不同父节点上指纹不同，不会误合并。
 */
function profileFingerprintOf(p: PresetProfile, parentFp: string | null): string {
    const content: Record<string, unknown> = {
        kind: p.kind === 'prompt_base' || p.kind === 'prompt_delta' ? p.kind : 'legacy',
    };
    if (p.kind === 'prompt_base') {
        content.prompts = p.prompts;
        if (p.unusedIds) content.unusedIds = p.unusedIds;
    } else if (p.kind === 'prompt_delta') {
        content.changes = p.changes;
        if (p.order) content.order = p.order;
        content.parent = parentFp;
    }
    if (p.sampling) content.sampling = p.sampling;
    if (p.extra) content.extra = p.extra;
    if (p.model) content.model = p.model;
    return stableStringify(content);
}

/** 为 profile 集合构建 id → 内容指纹 映射（沿父链递归，成环时父指纹为 null）。 */
function buildFingerprintMap(
    profilesById: Map<string, PresetProfile>,
    resolveExternalParent: (baseId: string) => string | null,
): Map<string, string | null> {
    const fpById = new Map<string, string | null>();
    const computing = new Set<string>();
    const compute = (id: string): string | null => {
        const cached = fpById.get(id);
        if (cached !== undefined) return cached;
        if (computing.has(id)) return null; // 父链成环 → 父指纹不可得
        const p = profilesById.get(id);
        if (!p) return null;
        computing.add(id);
        let parentFp: string | null = null;
        if (p.kind === 'prompt_delta' && p.baseId !== undefined) {
            parentFp = compute(String(p.baseId)) ?? resolveExternalParent(String(p.baseId));
        }
        const fp = profileFingerprintOf(p, parentFp);
        computing.delete(id);
        fpById.set(id, fp);
        return fp;
    };
    for (const id of profilesById.keys()) compute(id);
    return fpById;
}

/**
 * 解析导入的 v3 profile 数据，返回并入导入条目后的新 profiles 数组与警告消息。
 * 无 UI / 持久化副作用。warning 由调用方 toast。
 *
 * 导入设计：
 * - 只接受 v3 format（base / delta / prompt_tree），旧版 v1/v2 须先用 migrate-to-v3 工具转换。
 * - 所有 profile 重新分配 id，baseId 引用重映射到有效 id。
 * - 带内嵌父状态（base.prompts）的 delta 或 prompt_tree 条目：当父不在文件内时转成可见 base + delta 子节点。
 * - 内容去重并入：与现有 profiles（或本批已并入条目）内容指纹相同（kind + 语义字段 + delta 父链指纹）的条目跳过并提示。
 * - 跨文件合并：同一预设分多次导出的不同 profile 导入同一目标时，共享 base 只并入一次，后续 delta 挂到已有的相同内容父节点上。
 */
export function mergeImportedProfiles(
    parsed: Record<string, any>,
    existing: PresetProfile[],
    profileName: string,
    _meta: PresetMeta,
): { profiles: PresetProfile[]; warnings: string[]; addedCount: number } {
    const profiles = [...existing];
    const warnings: string[] = [];
    let addedCount = 0;
    const usedIds = new Set(profiles.map((p) => p.id));
    const freshId = (): string => {
        let id = newProfileId();
        while (usedIds.has(id)) id = newProfileId();
        usedIds.add(id);
        return id;
    };

    // 解析原始 v3 profile 列表
    const rawProfiles: (PromptBaseProfile | PromptDeltaProfile)[] = [];
    /** 带内嵌父状态的 delta：delta 原 id → 父状态 */
    const deltaBaseMap = new Map<string, { prompts: PromptProfileEntry[] }>();

    // 完整 preset 导出（含 extensions['preset_cards']）：直接从其中提取 profiles 数组
    const presetProfiles = extractProfilesFromPresetExport(parsed);
    /** 是否为完整 preset 导出（含 extensions['preset_cards']）；其空 profiles 也应视为合法导入（无条目可并入）。 */
    const isPresetExport = Array.isArray(presetProfiles);

    if (Array.isArray(presetProfiles)) {
        for (const p of presetProfiles) {
            if (isPromptBaseProfile(p)) {
                rawProfiles.push(makeBaseProfile({ id: p.id, name: p.name, prompts: p.prompts, ...(p.unusedIds ? { unusedIds: p.unusedIds } : {}), ...(p.sampling ? { sampling: p.sampling } : {}), ...(p.extra ? { extra: p.extra } : {}), ...(p.model ? { model: p.model } : {}) }));
            } else if (isPromptDeltaProfile(p)) {
                rawProfiles.push(makeDeltaProfile({ id: p.id, name: p.name, baseId: p.baseId, changes: p.changes, ...(p.order ? { order: p.order } : {}), ...(p.sampling ? { sampling: p.sampling } : {}), ...(p.extra ? { extra: p.extra } : {}), ...(p.model ? { model: p.model } : {}) }));
            }
        }
    } else if (parsed && parsed.kind === 'prompt_tree' && Array.isArray(parsed.profiles)) {
        for (const entry of parsed.profiles) {
            if (!entry) continue;
            if (entry.kind === 'prompt_base' && Array.isArray(entry.prompts)) {
                rawProfiles.push(makeBaseProfile({ id: entry.id, name: entry.name, prompts: entry.prompts, ...(entry.unusedIds ? { unusedIds: entry.unusedIds } : {}), ...(entry.sampling ? { sampling: entry.sampling } : {}), ...(entry.extra ? { extra: entry.extra } : {}), ...(entry.model ? { model: entry.model } : {}) }));
            } else if (entry.kind === 'prompt_delta' && Array.isArray(entry.changes)) {
                if (Array.isArray(entry.base?.prompts) && entry.id !== undefined) {
                    deltaBaseMap.set(String(entry.id), { prompts: entry.base.prompts });
                }
                rawProfiles.push(makeDeltaProfile({ id: entry.id, name: entry.name, baseId: entry.baseId, changes: entry.changes, ...(entry.order ? { order: entry.order } : {}), ...(entry.sampling ? { sampling: entry.sampling } : {}), ...(entry.extra ? { extra: entry.extra } : {}), ...(entry.model ? { model: entry.model } : {}) }));
            }
        }
    } else if (parsed && parsed.kind === 'prompt_base' && Array.isArray(parsed.prompts)) {
        rawProfiles.push(makeBaseProfile({ id: parsed.id, name: parsed.name, prompts: parsed.prompts, ...(parsed.unusedIds ? { unusedIds: parsed.unusedIds } : {}), ...(parsed.sampling ? { sampling: parsed.sampling } : {}), ...(parsed.extra ? { extra: parsed.extra } : {}), ...(parsed.model ? { model: parsed.model } : {}) }));
    } else if (parsed && parsed.kind === 'prompt_delta' && Array.isArray(parsed.changes)) {
        rawProfiles.push(makeDeltaProfile({ id: parsed.id, name: parsed.name, baseId: parsed.baseId, changes: parsed.changes, ...(parsed.order ? { order: parsed.order } : {}), ...(parsed.sampling ? { sampling: parsed.sampling } : {}), ...(parsed.extra ? { extra: parsed.extra } : {}), ...(parsed.model ? { model: parsed.model } : {}) }));
    } else {
        throw new Error('Imported configuration is not a valid v3 preset snapshot');
    }

    if (rawProfiles.length === 0) {
        // 完整 preset 导出：空 profiles 数组 = 合法空导入；非空但全部为非法/非 v3 条目 = 格式错误，禁止静默成功
        if (isPresetExport) {
            const rawArray = (parsed?.extensions?.[EXTENSION_KEY] as Record<string, unknown> | undefined)?.profiles;
            if (Array.isArray(rawArray) && rawArray.length > 0) {
                throw new LegacyProfileFormatError();
            }
            return { profiles, warnings, addedCount: 0 };
        }
        throw new Error('Imported configuration is not a valid v3 preset snapshot');
    }

    // profile id 是父链和所有后续操作的唯一锚点；重复 id 会让重映射与 baseId 指向产生歧义。
    const fileIds = new Set<string>();
    for (const profile of rawProfiles) {
        const id = String(profile.id);
        if (fileIds.has(id)) throw new Error('Imported configuration contains duplicate profile ids');
        fileIds.add(id);
    }

    // 处理带内嵌父状态的 delta：父不在文件内的，生成本地 base 作为父
    for (const [deltaId, baseState] of deltaBaseMap) {
        if (!fileIds.has(String(deltaId))) continue;
        const delta = rawProfiles.find((p) => String(p.id) === String(deltaId)) as PromptDeltaProfile | undefined;
        if (!delta) continue;
        // 父已在文件内 → 不需要额外处理
        if (fileIds.has(String(delta.baseId))) continue;
        // 父不在文件内 → 生成本地 base 锚定
        const baseId = freshId();
        rawProfiles.unshift(makeBaseProfile({ id: baseId, name: 'Imported Parent', prompts: baseState.prompts }));
        fileIds.add(baseId);
        // 更新 delta 的 baseId 指向新本地 base
        (delta as any).baseId = baseId;
    }

    // 处理孤立 delta（baseId 指向不存在的 profile）
    for (const raw of rawProfiles) {
        if (isPromptDeltaProfile(raw) && raw.baseId && !fileIds.has(String(raw.baseId))) {
            // 生成空 base 作为锚点
            const baseId = freshId();
            rawProfiles.unshift(makeBaseProfile({ id: baseId, name: 'Imported Parent', prompts: [] }));
            fileIds.add(baseId);
            (raw as any).baseId = baseId;
        }
    }

    // 指纹：现有 profiles 与文件内 raw profiles（含锚点）各自构建；delta 父链以指纹比较而非随机 baseId
    const existingById = new Map<string, PresetProfile>();
    for (const p of existing) existingById.set(String(p.id), p);
    const existingFpMap = buildFingerprintMap(existingById, () => null);
    const rawById = new Map<string, PresetProfile>();
    for (const raw of rawProfiles) rawById.set(String(raw.id), raw);
    const rawFpMap = buildFingerprintMap(rawById, (baseId) => existingFpMap.get(baseId) ?? null);

    // 第一遍：判定每个 raw 是「并入（分配新 id）」还是「跳过（内容与现有/本批重复）」，并记录父链接用的有效 id
    const fpToId = new Map<string, string>(); // 内容指纹 → 该指纹对应 profile 的有效 id（现有 id 或本批新 id）
    for (const [id, fp] of existingFpMap) {
        if (fp !== null && !fpToId.has(fp)) fpToId.set(fp, id);
    }
    const effectiveIdByRawId = new Map<string, string>(); // raw 原 id → 有效 id（并入的新 id，或跳过时对应的现有 id）
    const skippedRawIds = new Set<string>();
    let skippedCount = 0;
    for (const raw of rawProfiles) {
        if (raw.id === undefined) continue;
        const rawId = String(raw.id);
        const fp = rawFpMap.get(rawId) ?? null;
        if (fp !== null && fpToId.has(fp)) {
            // 内容重复 → 复用现有条目（不新增、不产生重复锚点）
            effectiveIdByRawId.set(rawId, fpToId.get(fp)!);
            skippedRawIds.add(rawId);
            skippedCount++;
        } else {
            const newId = freshId();
            effectiveIdByRawId.set(rawId, newId);
            if (fp !== null) fpToId.set(fp, newId);
        }
    }

    // 第二遍：写入（跳过的 raw 不写入；delta 父链接指向有效 id，父被去重跳过时也能挂到现有父上）
    const missingBaseIds: string[] = [];
    const targetId = typeof parsed.targetId === 'string' ? parsed.targetId : undefined;
    for (const raw of rawProfiles) {
        const rawId = String(raw.id);
        if (skippedRawIds.has(rawId)) continue;
        const id = effectiveIdByRawId.get(rawId);
        if (id === undefined) continue;
        const isTarget = targetId ? rawId === targetId : raw === rawProfiles[rawProfiles.length - 1];
        const name = isTarget ? profileName : raw.name;

        if (isPromptBaseProfile(raw)) {
            profiles.push({ ...raw, id, name });
            addedCount++;
        } else {
            const parentId = raw.baseId !== undefined ? effectiveIdByRawId.get(String(raw.baseId)) : undefined;
            if (!parentId && raw.baseId !== undefined && !existing.some((p) => String(p.id) === String(raw.baseId))) {
                missingBaseIds.push(String(raw.baseId));
            }
            profiles.push(makeDeltaProfile({ id, name, baseId: parentId ?? raw.baseId, changes: raw.changes, ...(raw.order ? { order: raw.order } : {}), ...(raw.sampling ? { sampling: raw.sampling } : {}), ...(raw.extra ? { extra: raw.extra } : {}), ...(raw.model ? { model: raw.model } : {}) }));
            addedCount++;
        }
    }
    if (missingBaseIds.length > 0) {
        warnings.push(L('Base profile not found for this imported derived configuration'));
    }
    if (skippedCount > 0) {
        warnings.push(`${L('Duplicate configuration skipped')}: ${skippedCount}`);
    }

    return { profiles, warnings, addedCount };
}

export type HeaderImportKind = 'preset' | 'v3profile' | 'native';

/**
 * 头部导入类型判定（三连）：
 * - 完整 preset（extensions['preset_cards'].profiles 为数组，含空数组）→ 'preset'
 * - v3 profile 载荷（单 base / 单 delta / prompt_tree）→ 'v3profile'
 * - 其余（普通 ST 预设 / v1/v2 / 损坏或未知格式）→ 'native'（回退 ST 原生导入）
 */
export function classifyHeaderImport(parsed: Record<string, unknown>): HeaderImportKind {
    if (Array.isArray(extractProfilesFromPresetExport(parsed))) return 'preset';
    try {
        assertV3ImportPayload(parsed);
        return 'v3profile';
    } catch {
        return 'native';
    }
}

/**
 * 判断本次并入是否需要「跨预设风险确认」：
 * - 完整 preset 导出：以文件内预设名与目标预设名比对，不同名（可能改名，也可能真是别的预设）→ 需要确认
 * - v3 profile / 来源不明的载荷：无预设名可比对 → 一律需要确认
 * 返回 true = 需要弹风险确认；false = 可视为同一预设的恢复，无需确认。
 */
export function isCrossPresetImport(parsed: Record<string, unknown>, targetName: string): boolean {
    if (!Array.isArray(extractProfilesFromPresetExport(parsed))) return true;
    const sourceName = typeof parsed.name === 'string' ? parsed.name : undefined;
    return sourceName !== targetName;
}

/**
 * 目标预设候选排序：同名候选**真实存在**时排首位；不存在时不得伪造该选项。
 * 文件名叫 A 但没有任何预设叫 A 时，返回原列表，避免出现选不到的 A 选项。
 */
export function orderPresetCandidates(names: string[], preferredFirst?: string): string[] {
    if (preferredFirst && names.includes(preferredFirst)) {
        return [preferredFirst, ...names.filter((n) => n !== preferredFirst)];
    }
    return [...names];
}