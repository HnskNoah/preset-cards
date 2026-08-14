import { getRequestHeaders } from '@sillytavern/script';
import { POPUP_TYPE, Popup, callGenericPopup } from '@sillytavern/scripts/popup';
import { oai_settings, openai_settings, openai_setting_names, settingsToUpdate, getChatCompletionPreset } from '@sillytavern/scripts/openai';
import { eventSource, event_types } from '@sillytavern/scripts/events';
import { download } from '@sillytavern/scripts/utils';
import { renderExtensionTemplateAsync } from '@sillytavern/scripts/extensions';
import { L } from './i18n.js';
import { EXTENSION_KEY, EXTENSION_NAME } from './constants.js';
import { getProfile, isPromptBaseProfile, isPromptDeltaProfile, persistMetaTransaction, readMeta, saveMeta } from './meta.js';
import type { Preset, PromptBaseProfile, PromptDeltaProfile, PromptModel } from './meta.js';
import { applyProfileToPreset, resolveProfileModel } from './promptToggle.js';
import { buildNewBaseProfile } from './profileMutators.js';
import { lockDefaultSnapshot } from './presetSnapshot.js';
import { applyBufferedEdits, clearBufferedForName } from './presetBuffers.js';
import { chooseFromOptions, classifyHeaderImport, extractProfilesFromPresetExport, isCrossPresetImport, mergeImportedProfiles, orderPresetCandidates } from './importExport.js';
import { assertV3ImportPayload, LegacyProfileFormatError } from './profileSchema.js';
import { getActiveProfile, setActiveProfile } from './activeProfile.js';
import { fastApplyPreset } from './fastApply.js';
import { getCardsTemplateContext } from './presetList.js';
import type { CardsContext } from './presetCardsContext.js';
import { clearImageCache, applyCachedBackgrounds } from './cache.js';
import { applyNameWrap } from './nameWrap.js';

/** profile 加载事件订阅回调。 */
export type ProfileChangedListener = (ref: { presetName: string; profileId: string }) => void;

/** 模块级 profile 加载监听器集合：所有加载路径（卡片行 / concise / window.presetCards.loadProfile）统一在此触发。 */
const profileChangedListeners = new Set<ProfileChangedListener>();

/** 订阅 profile 加载事件，返回退订函数。 */
export function onProfileChanged(listener: ProfileChangedListener): () => void {
    profileChangedListeners.add(listener);
    return () => { profileChangedListeners.delete(listener); };
}

function notifyProfileChanged(ref: { presetName: string; profileId: string }): void {
    for (const listener of [...profileChangedListeners]) {
        try {
            listener(ref);
        } catch (err) {
            console.error('preset-cards: profile changed listener failed', err);
        }
    }
}

/** 刷新当前活动预设的运行态：从内存 openai_settings 重载已保存状态（profile 编辑/重置后调用），
 * 走快路径 fastApplyPreset（内部含 render），不再触发原生 change 慢路径。 */
export function refreshActivePresetUI(presetName: string): void {
    if (oai_settings.preset_settings_openai === presetName) {
        const idx = openai_setting_names[presetName];
        if (idx !== undefined) void fastApplyPreset(idx, presetName);
    }
}

/** 激活 preset 并刷新运行态（走快路径 fastApplyPreset，不触发原生 change 慢路径）。 */
export function activatePreset(ctx: CardsContext, name: string, idx: number): void {
    void fastApplyPreset(idx, name);
    refreshActiveCardSelection(ctx);
}

/** 活动预设被删后重选第一个剩余预设并走快路径应用（无剩余时保持 null）。 */
export function reselectFirstPreset(): void {
    if (Object.keys(openai_setting_names).length) {
        const newActiveName = Object.keys(openai_setting_names)[0];
        oai_settings.preset_settings_openai = newActiveName;
        void fastApplyPreset(openai_setting_names[newActiveName], newActiveName);
    }
}

/** 刷新卡片选中态：清空后按当前活动预设重新高亮对应卡片。 */
export function refreshActiveCardSelection(ctx: CardsContext): void {
    ctx.dialog.find('.preset_card').removeClass('selected');
    const newActive = oai_settings.preset_settings_openai;
    if (newActive) {
        ctx.dialog.find('.preset_card').filter(function () {
            return $(this).attr('data-preset-name') === newActive;
        }).addClass('selected');
    }
}

/** 删除单个 preset 的公共例程：移除下拉 option → 清 openai_setting_names → 活动预设置空/重选 →
 * 服务端删除 → 成功路径删卡 + presets filter + onBeforeEmit + emit PRESET_DELETED。
 * 返回服务端是否确认删除成功；value 缺失（防御：批删循环已提前跳过）返回 false 不提示。 */
export async function deletePresetByName(
    ctx: CardsContext,
    nameToDelete: string,
    opts: {
        activeHandling: 'immediate' | 'deferred';
        emitLog: string;
        onDeleted?: () => void;
        onBeforeEmit?: () => void;
    },
): Promise<boolean> {
    const value = openai_setting_names[nameToDelete];
    if (value === undefined) return false;

    // 先等服务器确认删除成功，再动本地状态（避免删失败时本地已切走活动预设/清索引而无法回滚）。
    let response: Response;
    try {
        response = await fetch('/api/presets/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ apiId: 'openai', name: nameToDelete }),
        });
    } catch (err) {
        console.error('Delete preset request failed', err);
        toastr.error(L('Failed to delete preset from server'));
        return false;
    }

    if (!response.ok) return false;

    // 服务器确认成功：移除下拉、清索引、活动预设置空/重选
    $(`#settings_preset_openai option[value="${value}"]`).remove();
    delete openai_setting_names[nameToDelete];

    if (oai_settings.preset_settings_openai === nameToDelete) {
        oai_settings.preset_settings_openai = null;
        if (opts.activeHandling === 'immediate') {
            reselectFirstPreset();
        }
    }

    const active = getActiveProfile();
    if (active && active.presetName === nameToDelete) {
        setActiveProfile(undefined);
    }

    // V2：删除预设后清理其未提交缓冲（孤儿缓冲仅会在同一会话重建同名预设时被错误套用）
    clearBufferedForName(nameToDelete, ctx.sessionEdits, ctx.pendingToggles);

    opts.onDeleted?.();

    // Safely remove the card from the UI immediately
    ctx.dialog.find('.preset_card').filter(function () {
        return $(this).attr('data-preset-name') === nameToDelete;
    }).remove();

    // Re-evaluate counts and search
    ctx.presets = ctx.presets.filter(p => p.name !== nameToDelete);

    opts.onBeforeEmit?.();

    // Emit the event LAST to avoid being interrupted by other listeners
    try {
        await eventSource.emit(event_types.PRESET_DELETED, { apiId: 'openai', name: nameToDelete });
    } catch (err) {
        console.error(opts.emitLog, err);
    }

    return true;
}

/** 枚举指定预设下的 preset-cards profile（供外部扩展查询）。返回 { id, name } 列表。
 * 排除 archive（隐藏 base，与 UI 树一致）。 */
export function getPresetProfiles(name: string): { id: string; name: string }[] {
    const idx = openai_setting_names[name];
    if (idx === undefined) return [];
    const meta = readMeta(openai_settings[idx] as Preset);
    return (meta.profiles || [])
        .filter((p) => isPromptBaseProfile(p) || isPromptDeltaProfile(p))
        .map((p) => ({ id: String(p.id), name: p.name || String(p.id) }));
}

/** 列出所有含 preset-cards profile 的预设名。 */
export function listPresetsWithProfiles(): string[] {
    return Object.keys(openai_setting_names).filter((name) => getPresetProfiles(name).length > 0);
}

/** 查询 profile 解析后的模型快照（自身未记录时沿父链回溯）。 */
export function getProfileModel(name: string, profileId: string): PromptModel | undefined {
    const idx = openai_setting_names[name];
    if (idx === undefined) return undefined;
    const meta = readMeta(openai_settings[idx] as Preset);
    const profile = getProfile(meta, profileId);
    if (!profile) return undefined;
    return resolveProfileModel(profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]);
}

/** 按预设名 + profile id 应用 profile 到预设并持久化（不依赖卡片 UI ctx）。
 * 供卡片行 / concise 弹窗 / 外部扩展（如 ST-Quicker-Api 便捷方案）共用。成功返回 true。 */
export async function applyProfileToPresetByName(
    name: string,
    profileId: string,
): Promise<boolean> {
    const idx = openai_setting_names[name];
    if (idx === undefined) return false;
    const preset = openai_settings[idx] as Preset;
    const meta = readMeta(preset);
    const profile = getProfile(meta, profileId);
    if (!profile) return false;
    applyProfileToPreset(preset, profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[], {
        showMissingToast: true,
        defaultSampling: meta.defaultSampling,
        defaultExtra: meta.defaultExtra,
        defaultModel: meta.defaultModel,
        defaultSnapshot: meta.defaultSnapshot,
    });
    setActiveProfile({ presetName: name, profileId: String(profileId) });
    try {
        await saveMeta(name, idx, meta);
    } catch (err) {
        console.error('Load profile failed', err);
        toastr.error(L('Failed to save preset metadata'));
        return false;
    }
    notifyProfileChanged({ presetName: name, profileId: String(profileId) });
    return true;
}

/** 加载 profile 到 preset（卡片行与 concise 弹窗共用）。 */
export async function loadProfile(
    ctx: CardsContext,
    name: string,
    idx: number,
    profileId: string,
): Promise<void> {
    if (!await applyProfileToPresetByName(name, profileId)) return;
    toastr.success(L('Configuration loaded'));
    activatePreset(ctx, name, idx);
    clearBufferedForName(name, ctx.sessionEdits, ctx.pendingToggles);
    await refreshGrid(ctx);
}

/** 整卡列表重渲染并触发搜索过滤。 */
export async function refreshGrid(ctx: CardsContext, opts?: { applyBackgrounds?: boolean }): Promise<void> {
    const searchEl = ctx.dialog.find('#preset_cards_search');
    const query = String(searchEl.val() ?? '');
    const newHtml = await renderExtensionTemplateAsync(EXTENSION_NAME, 'cards', getCardsTemplateContext());
    ctx.dialog.html($(newHtml).html());
    if (opts?.applyBackgrounds !== false) applyCachedBackgrounds(ctx.dialog);
    applyNameWrap(ctx.dialog);
    if (query) ctx.dialog.find('#preset_cards_search').val(query);
    if (ctx.isConciseMode) ctx.dialog.find('#preset_cards_concise_btn').addClass('active');
    // 批量模式 UI 恢复：模板重建后重挂 batch class / 按钮可见性 / 已选高亮
    if (ctx.isBatchMode) {
        ctx.dialog.toggleClass('preset_cards_batch_mode', true);
        ctx.dialog.find('#preset_cards_multiselect_btn').addClass('active');
        ctx.dialog.find('#preset_cards_batch_delete_btn').removeClass('hidden');
        for (const selName of ctx.batchSelectedCards) {
            ctx.dialog.find(`.preset_card[data-preset-name="${selName}"]`).addClass('batch_selected');
        }
    }
    // 默认折叠：自动展开当前激活 profile 的祖先链，保证其可见
    ctx.dialog.find('.preset_card_profile_row.active').parents('.preset_card_profile_group').addClass('expanded');
    ctx.dialog.find('#preset_cards_search').trigger('input');
}

/** add base：保存当前 prompts 开关为主 profile。 */
export async function addBaseProfile(
    ctx: CardsContext,
    name: string,
    idx: number,
    profileName: string,
): Promise<void> {
    const preset = openai_settings[idx] as Preset;

    if (oai_settings.preset_settings_openai === name) {
        // 与 ST #update_oai_preset 全量保存语义一致
        const presetBody = getChatCompletionPreset(oai_settings);
        Object.assign(preset, presetBody);
        if (Array.isArray(oai_settings.prompt_order)) {
            preset.prompt_order = structuredClone(oai_settings.prompt_order);
        }
    }

    // 首次对该预设 add base：先全量锁定默认基线（编辑前状态），幂等。
    try {
        await lockDefaultSnapshot(preset, name, idx);

        const meta = readMeta(preset);

        // 新 base 快照须包含本会话缓冲的开关/值编辑：先统一应用缓冲再采集快照
        const missing = applyBufferedEdits(preset, name, ctx.sessionEdits, ctx.pendingToggles);
        if (missing.length > 0) {
            toastr.warning(`${L('Missing prompts skipped')}: ${missing.join(', ')}`);
        }

        // 副本模式事务：持久化含新 base 的 nextMeta，成功后才写回活 meta（失败重试不重复产生 base）
        const ok = await persistMetaTransaction(meta, (m) => ({
            ...m,
            profiles: [
                ...(Array.isArray(m.profiles) ? m.profiles : []),
                buildNewBaseProfile(preset, m.defaultSnapshot, profileName, m.defaultSampling, m.defaultExtra),
            ],
        }), name, idx);
        if (!ok) return;
    } catch (err) {
        console.error('Add base failed', err);
        toastr.error(L('Failed to save preset metadata'));
        return;
    }
    toastr.success(L('Base profile saved'));
    await refreshGrid(ctx);
}

/** 导出完整 preset JSON（剔除敏感连接字段）。
 * profileIds 为空表示导出全部 profiles；指定时为「只导出这些 profile + 预设本体」（单 profile 导出）。
 * fileName 指定下载文件名（不含 .json，自动补后缀），缺省用预设名。 */
export function exportPresetFile(name: string, idx: number, profileIds?: string[], fileName?: string): void {
    const preset = structuredClone(openai_settings[idx] as Preset);
    const sensitiveKeys = [
        'reverse_proxy', 'proxy_password', 'custom_url', 'custom_include_body', 'custom_exclude_body',
        'custom_include_headers', 'vertexai_region', 'vertexai_express_project_id', 'azure_base_url',
        'azure_deployment_name', 'workers_ai_account_id',
    ];
    for (const key of sensitiveKeys) delete preset[key];
    // 连接字段（settingsToUpdate 标记 is_connection=true）剔除
    for (const [key, [,, , isConnection]] of Object.entries(settingsToUpdate)) {
        if (isConnection) delete preset[key];
    }
    // 单 profile 导出：只保留指定 profile，其余剔除（profile 的 defaultSnapshot 等出厂基线随 meta 保留）
    if (profileIds && profileIds.length > 0) {
        const ext = preset.extensions?.[EXTENSION_KEY];
        if (ext && Array.isArray(ext.profiles)) {
            const keep = new Set(profileIds.map(String));
            ext.profiles = ext.profiles.filter((p: any) => keep.has(String(p.id)));
        }
    }
    const baseName = fileName?.trim() ? fileName.trim() : name;
    download(JSON.stringify(preset, null, 4), `${baseName}.json`, 'application/json');
}

/** 清空图片缓存并刷新。 */
export async function clearImageCacheAndRefresh(ctx: CardsContext): Promise<void> {
    const confirmed = await callGenericPopup(L('Clear all cached background images?'), POPUP_TYPE.CONFIRM);
    if (!confirmed) return;
    await clearImageCache();
    toastr.success(L('Cache cleared successfully'));
    await refreshGrid(ctx, { applyBackgrounds: true });
}

/** concise 长按弹窗：列出该预设全部可见 profile，点击加载。 */
export async function showConciseProfilesModal(ctx: CardsContext, card: JQuery<HTMLElement>): Promise<void> {
    const name = card.attr('data-preset-name') as string;
    const idx = card.data('preset-index') as number;
    const meta = readMeta(openai_settings[idx] as Preset);

    if (!meta.profiles || meta.profiles.length === 0) {
        toastr.info(L('No configurations saved for this preset'));
        return;
    }

    const container = $('<div class="preset_card_profiles_section" style="margin-top:0; padding:0; border:none; box-shadow:none; background:transparent;"></div>');
    const list = $('<div class="preset_card_profiles_list"></div>');

    meta.profiles.forEach(p => {
        const row = $('<div class="preset_card_profile_row" style="cursor:pointer; padding:10px 14px; margin-bottom:4px;"></div>')
            .attr('data-profile-id', String(p.id));
        row.append($('<div class="preset_card_profile_name" style="font-size:14px;"></div>').text(p.name));

        row.on('click', async function () {
            await loadProfile(ctx, name, idx, String(row.data('profile-id')));
            // 只关闭当前 concise 弹窗，避免全局选择器把底层卡片弹窗一起关掉
            $(this).closest('.popup').find('.popup-controls .menu_button').click();
        });

        list.append(row);
    });

    container.append(list);
    applyNameWrap(container);
    callGenericPopup(container, POPUP_TYPE.TEXT, '', { wide: false, large: false });
}

/** 解析并校验导入文件内容（完整 preset 或 v3 profile），出错时已 toast 并返回 null。 */
async function parseImportFile(file: File): Promise<Record<string, any> | null> {
    try {
        const text = await file.text();
        const parsed = JSON.parse(text) as Record<string, any>;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('Imported configuration is not a JSON object');
        }
        // 完整 preset 导出（含 extensions['preset_cards']）：提取其中 profiles 并入；其余走 v3 载荷校验。
        // 旧版 v1/v2 须先用 migrate-to-v3 工具转换。
        if (!extractProfilesFromPresetExport(parsed)) {
            assertV3ImportPayload(parsed);
        }
        return parsed;
    } catch (err) {
        console.error(err);
        toastr.error(L('Failed to parse configuration file'));
        return null;
    }
}

/** 选择 json 文件（promise 化）。选中文件 resolve(File)；取消/超时 resolve(null)，保证调用方 async 链必然结束。 */
export function pickJsonFile(): Promise<File | null> {
    return new Promise((resolve) => {
        let settled = false;
        const settle = (file: File | null) => {
            if (settled) return;
            settled = true;
            input.onchange = null;
            input.oncancel = null;
            window.clearTimeout(timer);
            resolve(file);
        };
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = () => settle(input.files?.[0] ?? null);
        input.oncancel = () => settle(null);
        // 兜底：个别浏览器不支持 file input 的 cancel 事件时，超时后结束悬空 async 链
        const timer = window.setTimeout(() => settle(null), 60_000);
        input.click();
    });
}

/** 把已选文件交给 ST 原生 preset 导入（合成 input 事件注入同文件，避免用户二次选择；环境不支持时降级为原生文件选择）。 */
function handFileToNativePresetImport(file: File): void {
    const input = document.getElementById('openai_preset_import_file') as HTMLInputElement | null;
    if (!input) {
        toastr.error(L('Failed to hand off to SillyTavern import'));
        return;
    }
    try {
        if (typeof DataTransfer === 'undefined') throw new Error('DataTransfer unavailable');
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        if (input.files?.[0] !== file) throw new Error('Programmatic file assignment failed');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (err) {
        // 合成事件不可用时降级为原生文件选择（用户需重新选一次文件），保证 ST 原生导入仍可用
        console.error('preset-cards: handoff to ST native import failed, falling back to picker', err);
        toastr.info(L('Please select the file again for the built-in import'));
        input.click();
    }
}

/** 把文件交给 ST 原生导入（还原 / 回退路径）。
 * 先关闭卡片弹窗：ST 原生导入及第三方扩展（如酒馆助手）会在导入事件时弹出确认，
 * 卡片弹窗保持打开会遮挡这些弹窗；merge 路径不受影响（不经过此函数）。 */
function handOffToNative(ctx: CardsContext, file: File): void {
    ctx.dialog.closest('.popup').find('.popup-controls .menu_button').click();
    handFileToNativePresetImport(file);
}

/** 把已解析的导入内容并入指定目标预设（风险确认 → 合并去重 → 有新条目才取名/锁基线/落盘 → 刷新；卡片/头部共用核心）。 */
async function mergeParsedToPreset(
    ctx: CardsContext,
    targetName: string,
    targetIdx: number,
    parsed: Record<string, any>,
    defaultName: string,
): Promise<boolean> {
    try {
        // 跨预设风险确认：完整 preset 不同名或 v3 profile 来源不明时，用户确认后才继续
        if (isCrossPresetImport(parsed, targetName)) {
            const confirmed = await callGenericPopup(L('Cross-preset import warning'), POPUP_TYPE.CONFIRM);
            if (!confirmed) return false;
        }

        // 先合并去重：全部重复时直接提示，不弹「配置名称」框
        const preset = openai_settings[targetIdx] as Preset;
        const meta = readMeta(preset);
        const { profiles, warnings, addedCount } = mergeImportedProfiles(parsed, meta.profiles, defaultName, meta);
        for (const warning of warnings) toastr.warning(warning);
        if (addedCount === 0) {
            toastr.info(L('No new configurations imported'));
            return true;
        }

        // 有新增条目：弹配置名；用户改名则更新最后一个新增 profile 的名字（新增项在 profiles 末尾追加）
        const profileName = await Popup.show.input(L('Configuration name:'), defaultName, defaultName);
        if (!profileName) return false;
        if (profileName !== defaultName && addedCount > 0) {
            const added = profiles.slice(-addedCount);
            const target = added[added.length - 1];
            if (target) target.name = profileName;
        }

        // 先采集出厂基线（lockDefaultSnapshot 内部幂等判 defaultSnapshotLocked），再副本事务落盘
        await lockDefaultSnapshot(preset, targetName, targetIdx);
        const lockedMeta = readMeta(preset);
        const ok = await persistMetaTransaction(lockedMeta, (m) => ({ ...m, profiles }), targetName, targetIdx);
        if (!ok) return false;
        toastr.success(L('Configuration saved'));
        await refreshGrid(ctx, { applyBackgrounds: true });
        return true;
    } catch (err) {
        console.error(err);
        if (err instanceof LegacyProfileFormatError) {
            toastr.error(L('Failed to parse configuration file'));
        } else {
            toastr.error(L('Failed to save preset metadata'));
        }
        return false;
    }
}

/** 选择并入目标预设（列出全部现有预设；同名候选存在时排首位；无预设时 toast 并返回 null）。 */
async function chooseTargetPreset(preferredFirst?: string): Promise<{ name: string; idx: number } | null> {
    const names = Object.keys(openai_setting_names);
    if (names.length === 0) {
        toastr.warning(L('No presets available to merge into'));
        return null;
    }
    // 同名候选只有真实存在时才排首位——文件名叫 A 但没有任何预设叫 A 时，不得伪造 A 选项
    const candidates = orderPresetCandidates(names, preferredFirst);
    const name = await chooseFromOptions<string>(L('Select target preset'), candidates.map((n) => [n, n]));
    if (!name) return null;
    const idx = openai_setting_names[name];
    if (idx === undefined) return null;
    return { name, idx };
}

/** 导入 profile 文件（卡片「导入配置」入口）：目标 = 当前卡片对应预设。 */
export async function importProfileFile(ctx: CardsContext, name: string, idx: number, file: File): Promise<void> {
    const parsed = await parseImportFile(file);
    if (!parsed) return;
    const ok = await mergeParsedToPreset(ctx, name, idx, parsed, file.name.replace(/\.json$/i, ''));
    if (!ok) return;
    ctx.dialog.find(`.preset_card[data-preset-name="${name}"]`).find('.preset_card_profile_group').addClass('expanded');
}

/** 头部「导入预设」入口：插件接管文件读取并按类型分流——完整 preset 并入/还原、v3 profile 选预设并入、其余回退 ST 原生。 */
export async function importPresetFromHeader(ctx: CardsContext): Promise<void> {
    const file = await pickJsonFile();
    if (!file) return;

    let parsed: Record<string, any>;
    try {
        parsed = JSON.parse(await file.text());
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('Imported configuration is not a JSON object');
        }
    } catch (err) {
        console.error(err);
        toastr.error(L('Failed to parse configuration file'));
        return;
    }
    const defaultName = file.name.replace(/\.json$/i, '');
    const kind = classifyHeaderImport(parsed);

    if (kind === 'preset') {
        // 完整 preset 文件：并入现有预设（去重重建节点），或作为新预设导入（ST 原生还原）
        const choice = await chooseFromOptions<string>(L('Import preset'), [
            [L('Merge into existing preset'), 'merge'],
            [L('Import as new preset'), 'restore'],
        ]);
        if (!choice) return;
        if (choice === 'restore') {
            handOffToNative(ctx, file);
            return;
        }
        const target = await chooseTargetPreset(defaultName); // 同名候选排首位
        if (!target) return;
        await mergeParsedToPreset(ctx, target.name, target.idx, parsed, defaultName);
        return;
    }

    if (kind === 'v3profile') {
        // v3 profile 文件：选择目标预设并入
        const target = await chooseTargetPreset();
        if (!target) return;
        await mergeParsedToPreset(ctx, target.name, target.idx, parsed, defaultName);
        return;
    }

    // 其他（普通 ST 预设 / v1/v2 / 未知格式）：回退 ST 原生导入，先关卡片避免第三方确认被遮
    handOffToNative(ctx, file);
}
