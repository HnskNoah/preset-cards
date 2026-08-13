import { POPUP_TYPE, callGenericPopup } from '@sillytavern/scripts/popup';
import { L } from './i18n.js';
import {
    getProfile,
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
import { resolveParentStates } from './promptToggle.js';
export function chooseProfileSaveTarget(): Promise<'update' | 'create' | null> {
    return chooseFromOptions(L('Save changes to'), [
        [L('Update current profile'), 'update'],
        [L('Create new subprofile'), 'create'],
    ]);
}

// 导出方式选择弹窗：单一导出 / 关系链导出 / 取消（完整预设导出直接用 ST 自带功能）
export function chooseProfileExportAction(): Promise<'profile' | 'tree' | null> {
    return chooseFromOptions(L('Export configuration'), [
        [L('Export'), 'profile'],
        [L('Export with branch chain'), 'tree'],
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

// 单 profile 自包含导出（fv3）：base → prompt_base / delta → 附解析后完整父状态快照。
// 附带 preset 的 defaultSnapshot + defaultSampling + defaultExtra（出厂基线），导入后 reset 仍可还原出厂值。
export function buildProfileExportData(profile: PresetProfile, meta: PresetMeta): string {
    const base = (meta.defaultSnapshot && meta.defaultSnapshot.length > 0) ? meta.defaultSnapshot : undefined;
    const baseline = {
        ...(base ? { defaultSnapshot: base, defaultSnapshotLocked: meta.defaultSnapshotLocked === true } : {}),
        ...(meta.defaultSampling ? { defaultSampling: meta.defaultSampling } : {}),
        ...(meta.defaultExtra ? { defaultExtra: meta.defaultExtra } : {}),
    };
    if (isPromptBaseProfile(profile)) {
        return JSON.stringify({
            kind: profile.kind,
            formatVersion: profile.formatVersion,
            prompts: profile.prompts,
            ...(profile.unusedIds ? { unusedIds: profile.unusedIds } : {}),
            ...(profile.sampling ? { sampling: profile.sampling } : {}),
            ...(profile.extra ? { extra: profile.extra } : {}),
            ...(profile.model ? { model: profile.model } : {}),
            ...baseline,
        }, null, 4);
    }
    if (isPromptDeltaProfile(profile)) {
        const parentState = resolveParentStates(profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]);
        return JSON.stringify({
            kind: profile.kind,
            formatVersion: profile.formatVersion,
            baseId: profile.baseId,
            base: {
                name: 'Imported Parent',
                prompts: parentState,
            },
            changes: profile.changes,
            ...(profile.order ? { order: profile.order } : {}),
            ...(profile.sampling ? { sampling: profile.sampling } : {}),
            ...(profile.extra ? { extra: profile.extra } : {}),
            ...(profile.model ? { model: profile.model } : {}),
            ...baseline,
        }, null, 4);
    }
    return '';
}

// 导出完整分支树 prompt_tree：收集全部 base/delta，按 root→leaf（DFS）排序。
export function buildTreeExportData(meta: PresetMeta, targetId?: string): string {
    const profiles = meta.profiles.filter(p => isPromptBaseProfile(p) || isPromptDeltaProfile(p)) as (PromptBaseProfile | PromptDeltaProfile)[];
    const childrenByParent = new Map<string, PromptDeltaProfile[]>();
    for (const p of profiles) {
        if (isPromptDeltaProfile(p)) {
            const list = childrenByParent.get(p.baseId) ?? [];
            list.push(p);
            childrenByParent.set(p.baseId, list);
        }
    }
    const ordered: (PromptBaseProfile | PromptDeltaProfile)[] = [];
    const visited = new Set<string>();
    const visit = (p: PromptBaseProfile | PromptDeltaProfile): void => {
        if (visited.has(p.id)) return;
        if (isPromptDeltaProfile(p)) {
            const parent = getProfile(meta, p.baseId);
            if (parent && (isPromptBaseProfile(parent) || isPromptDeltaProfile(parent))) visit(parent);
        }
        visited.add(p.id);
        ordered.push(p);
        for (const child of childrenByParent.get(p.id) ?? []) visit(child);
    };
    for (const p of profiles) {
        if (isPromptBaseProfile(p)) visit(p);
    }
    for (const p of profiles) {
        if (!visited.has(p.id)) visit(p);
    }
    const payload = {
        kind: 'prompt_tree' as const,
        formatVersion: 3,
        profiles: structuredClone(ordered),
        ...((meta.defaultSnapshot && meta.defaultSnapshot.length > 0)
            ? { defaultSnapshot: meta.defaultSnapshot, defaultSnapshotLocked: meta.defaultSnapshotLocked === true }
            : {}),
        ...(meta.defaultSampling ? { defaultSampling: meta.defaultSampling } : {}),
        ...(meta.defaultExtra ? { defaultExtra: meta.defaultExtra } : {}),
        ...(targetId ? { targetId } : {}),
    };
    return JSON.stringify(payload, null, 4);
}

/**
 * 解析导入的 v3 profile 数据，返回并入导入条目后的新 profiles 数组与警告消息。
 * 无 UI / 持久化副作用。warning 由调用方 toast。
 *
 * 导入设计：
 * - 只接受 v3 format（base / delta / prompt_tree），旧版 v1/v2 须先用 migrate-to-v3 工具转换。
 * - 所有 profile 重新分配 id，baseId 引用通过 idMap 重映射到新 id。
 * - 带内嵌父状态（base.prompts）的 delta 或 prompt_tree 条目：当父不在文件内时转成可见 base + delta 子节点。
 */
export function mergeImportedProfiles(
    parsed: Record<string, any>,
    existing: PresetProfile[],
    profileName: string,
    _meta: PresetMeta,
): { profiles: PresetProfile[]; warnings: string[] } {
    const profiles = [...existing];
    const warnings: string[] = [];
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

    if (parsed && parsed.kind === 'prompt_tree' && Array.isArray(parsed.profiles)) {
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
        throw new Error('Imported configuration is not a valid v3 preset snapshot');
    }

    // 文件内 id 集合
    const fileIds = new Set(rawProfiles.map((p) => String(p.id)));

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

    // id 重映射 + 写入
    const idMap = new Map<string, string>();
    for (const raw of rawProfiles) {
        if (raw.id !== undefined) idMap.set(String(raw.id), freshId());
    }
    const missingBaseIds: string[] = [];
    const targetId = typeof parsed.targetId === 'string' ? parsed.targetId : undefined;
    for (const raw of rawProfiles) {
        const id = idMap.get(String(raw.id)) ?? freshId();
        const isTarget = targetId ? String(raw.id) === targetId : raw === rawProfiles[rawProfiles.length - 1];
        const name = isTarget ? profileName : raw.name;

        if (isPromptBaseProfile(raw)) {
            profiles.push({ ...raw, id, name });
        } else {
            const mappedBase = idMap.get(String(raw.baseId));
            if (!mappedBase && !existing.some((p) => String(p.id) === String(raw.baseId))) {
                missingBaseIds.push(String(raw.baseId));
            }
            profiles.push(makeDeltaProfile({ id, name, baseId: mappedBase ?? raw.baseId, changes: raw.changes, ...(raw.order ? { order: raw.order } : {}), ...(raw.sampling ? { sampling: raw.sampling } : {}), ...(raw.extra ? { extra: raw.extra } : {}), ...(raw.model ? { model: raw.model } : {}) }));
        }
    }
    if (missingBaseIds.length > 0) {
        warnings.push(L('Base profile not found for this imported derived configuration'));
    }

    return { profiles, warnings };
}