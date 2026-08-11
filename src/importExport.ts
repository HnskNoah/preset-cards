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
    type PromptDefaultSnapshotEntry,
    type PromptDeltaProfile,
    type PromptProfileEntry,
} from './meta.js';
import { promptFieldsEqual, resolveProfilePrompts, resolveParentStates, snapshotToDelta } from './promptToggle.js';
import { buildArchiveBase, isArchiveProfile, makeBaseProfile, makeDeltaProfile } from './profileActions.js';

// Two-button choice popup: update current profile, or create a new subprofile (delta).
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

    // okButton: false 用 popup 内置的隐藏行为（TEXT 类型对 false 隐藏 OK 按钮），按钮仍在 DOM，
    // resolveChoice 里 .click() 仍能正常触发关闭
    // onClose：Escape 等非按钮关闭路径的兜底，确保 promise 一定 resolve（不永久挂起）；已 settle 时忽略
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

/** 判断导入的 profile 是否相对出厂基线有差异（无差异则不建 archive base）。 */
function profileDiffersFromDefault(profile: PromptBaseProfile, meta: PresetMeta): boolean {
    const snap = meta.defaultSnapshot ?? [];
    const snapById = new Map<string, PromptDefaultSnapshotEntry>(snap.map((e) => [e.identifier, e]));

    // 挂载态差异：mounted 集合或 enabled 不同
    const profileMounted = new Set(profile.prompts.filter((e) => e.mounted).map((e) => e.identifier));
    const snapMounted = new Set(snap.filter((e) => e.mounted).map((e) => e.identifier));
    if (profileMounted.size !== snapMounted.size) return true;
    for (const id of profileMounted) {
        if (!snapMounted.has(id)) return true;
    }
    for (const entry of profile.prompts) {
        if (!entry.mounted) continue;
        const base = snapById.get(entry.identifier);
        if (!base) return true;
        if (base.enabled !== entry.enabled) return true;
        if (!promptFieldsEqual(base.originalFields ?? {}, entry.fields ?? {})) return true;
    }
    // unusedIds 差异
    const profileUnused = new Set(profile.unusedIds ?? []);
    const snapUnused = new Set(snap.filter((e) => !e.mounted).map((e) => e.identifier));
    if (profileUnused.size !== snapUnused.size) return true;
    for (const id of profileUnused) {
        if (!snapUnused.has(id)) return true;
    }
    // 采样差异
    if (JSON.stringify(profile.sampling ?? null) !== JSON.stringify(meta.defaultSampling ?? null)) return true;
    // extra 差异
    if (JSON.stringify(profile.extra ?? null) !== JSON.stringify(meta.defaultExtra ?? null)) return true;
    return false;
}

// 单 profile 自包含导出（fv3）：base → prompt_base（含 mounted/unused/order/sampling/extra）/ delta → 附解析后完整状态快照。
// 附带预设的 defaultSnapshot + defaultSampling + defaultExtra（出厂基线）与 locked 标记：导入后 reset 仍可还原出厂值。
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
            ...baseline,
        }, null, 4);
    }
    if (isPromptDeltaProfile(profile)) {
        // 导出自包含：内嵌「父状态」（不含 delta 自身 changes），导入时 delta 的 changes 叠加其上 = 完整还原。
        // 若内嵌完整状态（含 changes）作 base，导入再叠 changes 会双重应用。
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
            ...baseline,
        }, null, 4);
    }
    return JSON.stringify(profile.settings, null, 4);
}

// 导出完整分支树 prompt_tree：收集全部非 archive 的 base/delta，按 root→leaf（DFS）排序。
// archive 隐藏 base 不导出；其 delta 子节点作为孤立根收尾（baseId 指向未导出的 archive，再导入会断链告警，
// 但保持「不导出隐藏 archive」的语义优先——archive 是导入坐标系锚点，不应泄露进导出文件）。
export function buildTreeExportData(meta: PresetMeta, targetId?: string): string {
    const profiles = meta.profiles.filter(p => (isPromptBaseProfile(p) || isPromptDeltaProfile(p)) && !isArchiveProfile(p as PromptBaseProfile)) as (PromptBaseProfile | PromptDeltaProfile)[];
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
        // 父链回溯时遇到 archive 隐藏 base：不访问它（不导出 archive），当前 delta 留作孤立收尾
        if (isPromptDeltaProfile(p)) {
            const parent = getProfile(meta, p.baseId);
            if (parent && isArchiveProfile(parent as PromptBaseProfile)) {
                visited.add(p.id);
                ordered.push(p);
                return;
            }
            if (parent && (isPromptBaseProfile(parent) || isPromptDeltaProfile(parent))) visit(parent);
        }
        visited.add(p.id);
        ordered.push(p);
        for (const child of childrenByParent.get(p.id) ?? []) visit(child);
    };
    for (const p of profiles) {
        if (isPromptBaseProfile(p)) visit(p);
    }
    // 孤立 delta（baseId 无对应 base/delta 或被 archive 隐藏）：随 root 树之后收尾
    for (const p of profiles) {
        if (!visited.has(p.id)) visit(p);
    }
    // archive 的直接 delta 子节点：内嵌「父状态」（archive 的解析状态，不含 delta 自身 changes），
    // 保证树导出→再导入不丢继承的父链条目，且不与 delta 的 changes 双重应用。
    // 与单 delta 导出（buildProfileExportData）的 embedded base 格式对齐。
    const exported = ordered.map((p) => {
        if (isPromptDeltaProfile(p)) {
            const parent = getProfile(meta, p.baseId);
            if (parent && isArchiveProfile(parent as PromptBaseProfile)) {
                const parentState = resolveProfilePrompts(parent as PromptBaseProfile | PromptDeltaProfile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]);
                return { ...p, base: { name: 'Imported Parent', prompts: parentState } };
            }
        }
        return p;
    });
    const payload = {
        kind: 'prompt_tree' as const,
        formatVersion: 3,
        profiles: structuredClone(exported),
        // 附带预设 defaultSnapshot（出厂基线）与 locked 标记：导入后 reset 仍可还原出厂值
        ...((meta.defaultSnapshot && meta.defaultSnapshot.length > 0)
            ? { defaultSnapshot: meta.defaultSnapshot, defaultSnapshotLocked: meta.defaultSnapshotLocked === true }
            : {}),
        ...(meta.defaultSampling ? { defaultSampling: meta.defaultSampling } : {}),
        ...(meta.defaultExtra ? { defaultExtra: meta.defaultExtra } : {}),
        ...(targetId ? { targetId } : {}),
    };
    return JSON.stringify(payload, null, 4);
}

// 防御性提示：v1 快照无父链、不参与整树导出；仅提醒，不改变导出内容
export function warnV1ExcludedFromTreeExport(meta: PresetMeta): void {
    if (meta.profiles.some((p) => !isPromptBaseProfile(p) && !isPromptDeltaProfile(p))) {
        toastr.warning(L('Legacy v1 profiles are not included in the tree export'));
    }
}

/**
 * 解析导入的 profile 数据，返回并入导入条目后的新 profiles 数组、警告消息、以及新建的 archive base id。
 * 无 UI / 持久化副作用。warning 由调用方 toast。
 *
 * 导入统一设计：
 * - 任何导入文件，若其内容相对出厂 defaultSnapshot 有差异，先生成一个隐藏 archive base（作坐标系锚点）；
 *   无差异则不建（且不删除 defaultSnapshot）。
 * - v1 全量快照 → convertV1ToBase → archive base（隐藏）。archive 本身就是相对出厂基线的差异集。
 * - fv3 base → 挂该次导入的 archive base 下，转成 delta（changes 相对 archive）。
 * - fv3 delta → 挂该次导入的 archive base 下（保留自身变化）。
 * - archive base 隐藏（不进树），最后一个可见子节点删除时由调用方级联删除。
 */
export function mergeImportedProfiles(
    parsed: Record<string, any>,
    existing: PresetProfile[],
    profileName: string,
    meta: PresetMeta,
): { profiles: PresetProfile[]; warnings: string[]; archiveBaseId?: string } {
    const profiles = [...existing];
    const warnings: string[] = [];
    const usedIds = new Set(profiles.map((p) => p.id));
    const freshId = (): string => {
        let id = newProfileId();
        while (usedIds.has(id)) id = newProfileId();
        usedIds.add(id);
        return id;
    };

    // ---- v1 全量设置快照：含 prompts 数组且无 kind → 迁移为隐藏 archive base + 可见 delta 子节点 ----
    if (parsed && typeof parsed === 'object' && parsed.kind === undefined && Array.isArray(parsed.prompts)) {
        if (!profileDiffersFromDefault(buildArchiveBase({ id: freshId(), name: profileName, settings: parsed }), meta)) {
            // 与出厂基线无差异：不建 archive base（不删除 defaultSnapshot）
            return { profiles, warnings };
        }
        // 隐藏 archive base（坐标系锚点）+ 可见 delta 子节点（导入的 v1 配置，用户可加载/编辑派生）
        const archive = buildArchiveBase({ id: freshId(), name: profileName, settings: parsed });
        profiles.push(archive);
        const visible = makeDeltaProfile({ id: freshId(), name: profileName, baseId: archive.id, changes: [] });
        profiles.push(visible);
        return { profiles, warnings, archiveBaseId: archive.id };
    }

    // ---- fv3 base / delta / prompt_tree ----
    // 解析出的「用户可见 profile」集合（archive 除外）
    const rawProfiles: (PromptBaseProfile | PromptDeltaProfile)[] = [];
    /** 带内嵌父状态的 delta：delta 原 id → 父状态（树/单 delta 导出时为 archive 或父 base 的解析状态）。
     * 用于多 archive 场景：每个带 base 的 delta 独立建 archive 锚定，避免全部挂到单个根 archive。 */
    const deltaBaseMap = new Map<string, { prompts: PromptProfileEntry[] }>();
    if (parsed && parsed.kind === 'prompt_tree' && Array.isArray(parsed.profiles)) {
        for (const entry of parsed.profiles) {
            if (!entry) continue;
            if (entry.kind === 'prompt_base' && Array.isArray(entry.prompts)) {
                rawProfiles.push(makeBaseProfile({ id: entry.id, name: entry.name, prompts: entry.prompts, ...(entry.unusedIds ? { unusedIds: entry.unusedIds } : {}), ...(entry.sampling ? { sampling: entry.sampling } : {}), ...(entry.extra ? { extra: entry.extra } : {}) }));
            } else if (entry.kind === 'prompt_delta' && Array.isArray(entry.changes)) {
                if (Array.isArray(entry.base?.prompts) && entry.id !== undefined) {
                    deltaBaseMap.set(String(entry.id), { prompts: entry.base.prompts });
                }
                rawProfiles.push(makeDeltaProfile({ id: entry.id, name: entry.name, baseId: entry.baseId, changes: entry.changes, ...(entry.order ? { order: entry.order } : {}), ...(entry.sampling ? { sampling: entry.sampling } : {}), ...(entry.extra ? { extra: entry.extra } : {}) }));
            }
        }
    } else if (parsed && parsed.kind === 'prompt_base' && Array.isArray(parsed.prompts)) {
        rawProfiles.push(makeBaseProfile({ id: parsed.id, name: parsed.name, prompts: parsed.prompts, ...(parsed.unusedIds ? { unusedIds: parsed.unusedIds } : {}), ...(parsed.sampling ? { sampling: parsed.sampling } : {}), ...(parsed.extra ? { extra: parsed.extra } : {}) }));
    } else if (parsed && parsed.kind === 'prompt_delta' && Array.isArray(parsed.changes)) {
        rawProfiles.push(makeDeltaProfile({ id: parsed.id, name: parsed.name, baseId: parsed.baseId, changes: parsed.changes, ...(parsed.order ? { order: parsed.order } : {}), ...(parsed.sampling ? { sampling: parsed.sampling } : {}), ...(parsed.extra ? { extra: parsed.extra } : {}) }));
    } else {
        throw new Error('Imported configuration is not a valid preset snapshot (missing prompts array)');
    }

    if (rawProfiles.length === 0) {
        throw new Error('Imported configuration is not a valid preset snapshot (missing prompts array)');
    }

    // 找根 base（首个 base，或 targetId 指向的 profile）
    const targetId = typeof parsed.targetId === 'string' ? parsed.targetId : undefined;
    const firstBase = rawProfiles.find(isPromptBaseProfile);
    // 内嵌完整父状态（parsed.base.prompts）：单 delta 导出、或 tree 中 archive 的直接 delta 子节点（父不在文件内）
    // 都带 base，作为根可完整还原。父已在文件内的 delta 用 rawProfiles 里的父，不取 embeddedBase。
    const embeddedBaseRaw = (parsed && parsed.kind === 'prompt_delta' && Array.isArray(parsed.base?.prompts))
        ? parsed.base
        : (parsed && parsed.kind === 'prompt_tree' && Array.isArray(parsed.profiles))
            ? parsed.profiles.find((e: any) => e && e.kind === 'prompt_delta' && Array.isArray(e.base?.prompts))?.base
            : undefined;
    const embeddedBase = embeddedBaseRaw && Array.isArray(embeddedBaseRaw.prompts)
        ? makeBaseProfile({ id: parsed.baseId, name: embeddedBaseRaw.name ?? 'Imported Parent', prompts: embeddedBaseRaw.prompts })
        : undefined;
    // 根内容相对出厂基线是否有差异（决定是否建 archive）
    const rootProfile: PromptBaseProfile | undefined = firstBase
        ? firstBase
        : (embeddedBase ?? resolveImportedRootDelta(rawProfiles));
    // 建 archive 的时机：根内容与出厂基线有差异，或存在「父不在文件内」的 delta（embedded base / 孤立根）需要锚定。
    // 后者即使内容 == 出厂基线也要建，否则 delta 的 baseId 落到不存在的源 id 上造成悬空。
    const needArchive = rootProfile
        ? (profileDiffersFromDefault(rootProfile, meta) || (rootProfile !== firstBase && rawProfiles.some((p) => isPromptDeltaProfile(p))))
        : false;

    // 建 archive base：
    // - rootArchiveId：根 archive（对应 firstBase 或「根 delta」= 第一个带 base 的 delta 的父状态 / 孤立根），承载无 base 的孤立 delta 与 base 转 delta。
    // - deltaOwnArchiveId：除根 delta 外，每个「带内嵌父状态」的 delta 独立建 archive 锚定（多 archive 场景，避免全部挂到根）。
    // 根 archive 对应 firstBase，或「根 delta」= 第一个带内嵌 base 的 delta 的父状态（纯 delta 树时）。
    // 纯 delta 树：根 delta 挂根 archive，其余带 base 的 delta 各建独立 archive。
    // 有 firstBase：所有带 base 的 delta 各建独立 archive（其父是外部 archive，非文件内 base）。
    const rootDeltaId = firstBase ? undefined : (deltaBaseMap.keys().next().value as string | undefined);
    let rootArchiveId: string | undefined;
    const deltaOwnArchiveId = new Map<string, string>();
    if (needArchive) {
        const rootArchive = buildArchiveBaseFromRoot(rootProfile as PromptBaseProfile);
        profiles.push(rootArchive);
        rootArchiveId = rootArchive.id;
        for (const [deltaId, baseState] of deltaBaseMap) {
            if (deltaId === rootDeltaId) continue;
            const own = buildArchiveBaseFromRoot(makeBaseProfile({ id: 'tmp', name: 'Imported Archive', prompts: baseState.prompts }));
            profiles.push(own);
            deltaOwnArchiveId.set(deltaId, own.id);
        }
    }

    // id 重映射（原 id → 新 id），挂 archive 下转 delta
    const idMap = new Map<string, string>();
    for (const raw of rawProfiles) {
        if (raw.id !== undefined) idMap.set(String(raw.id), freshId());
    }
    const missingBaseIds: string[] = [];
    for (const raw of rawProfiles) {
        const id = idMap.get(String(raw.id)) ?? freshId();
        const isTarget = targetId ? String(raw.id) === targetId : raw === rawProfiles[rawProfiles.length - 1];
        const name = isTarget ? profileName : raw.name;

        if (isPromptBaseProfile(raw)) {
            // base 一律转 delta 挂 archive 下（archive 不存在时挂自身——表示无差异直接作为普通 base）
            if (rootArchiveId) {
                const resolved = resolveProfilePrompts(raw, rawProfiles);
                const rootResolved = rootProfile ? resolveProfilePrompts(rootProfile, rawProfiles) : resolved;
                const delta = snapshotToDelta(resolved, rootResolved, raw.unusedIds ?? []);
                profiles.push(makeDeltaProfile({ id, name, baseId: rootArchiveId, changes: delta.changes, ...(delta.order ? { order: delta.order } : {}), ...(raw.sampling ? { sampling: raw.sampling } : {}), ...(raw.extra ? { extra: raw.extra } : {}) }));
            } else {
                // 无差异：base 直接作为普通可见 base（无需 archive 桥）
                profiles.push({ ...raw, id, name });
            }
        } else {
            const mappedBase = idMap.get(String(raw.baseId));
            // 父解析优先级：文件内 idMap → 该 delta 自己的 archive → 根 archive → 原始 baseId。
            // 带内嵌 base 的 delta 用自己 archive 锚定（多 archive 正确性）。
            const ownArchive = deltaOwnArchiveId.get(String(raw.id));
            const resolvedBaseId = ownArchive ?? mappedBase ?? (rootArchiveId ?? raw.baseId);
            if (!mappedBase && !ownArchive && !rootArchiveId && !existing.some((p) => String(p.id) === String(raw.baseId))) {
                missingBaseIds.push(String(raw.baseId));
            }
            profiles.push(makeDeltaProfile({ id, name, baseId: resolvedBaseId, changes: raw.changes, ...(raw.order ? { order: raw.order } : {}), ...(raw.sampling ? { sampling: raw.sampling } : {}), ...(raw.extra ? { extra: raw.extra } : {}) }));
        }
    }
    if (missingBaseIds.length > 0) {
        warnings.push(L('Base profile not found for this imported derived configuration'));
    }

    return { profiles, warnings, archiveBaseId: rootArchiveId };
}

/** 从导入的根 delta（无 base 时）构造根状态，用于差异检测。 */
function resolveImportedRootDelta(
    rawProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
): PromptBaseProfile | undefined {
    // 找到「父不在本文件内」的 delta 作为根
    const localIds = new Set(rawProfiles.map((p) => String(p.id)));
    const root = rawProfiles.find((p) => isPromptDeltaProfile(p) && p.baseId && !localIds.has(String(p.baseId))) as PromptDeltaProfile | undefined;
    if (!root) return undefined;
    const resolved = resolveProfilePrompts(root, rawProfiles);
    if (resolved.length === 0) return undefined;
    return makeBaseProfile({ id: root.baseId || 'imported-root', name: root.name, prompts: resolved });
}

/** 从根状态构造 archive base（相对出厂基线的差异集）。 */
function buildArchiveBaseFromRoot(root: PromptBaseProfile): PromptBaseProfile {
    const prompts: PromptProfileEntry[] = root.prompts.map((e) => ({ ...e, fields: e.fields ? { ...e.fields } : undefined }));
    return makeBaseProfile({ id: newProfileId(), name: 'Imported Archive', prompts, ...(root.sampling ? { sampling: root.sampling } : {}), ...(root.extra ? { extra: root.extra } : {}), archive: true });
}
