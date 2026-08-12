import { getRequestHeaders } from '@sillytavern/script';
import { POPUP_TYPE, Popup, callGenericPopup } from '@sillytavern/scripts/popup';
import { oai_settings, openai_settings, openai_setting_names, settingsToUpdate, getChatCompletionPreset } from '@sillytavern/scripts/openai';
import { eventSource, event_types } from '@sillytavern/scripts/events';
import { download } from '@sillytavern/scripts/utils';
import { renderExtensionTemplateAsync } from '@sillytavern/scripts/extensions';
import { L } from './i18n.js';
import { EXTENSION_NAME } from './constants.js';
import { getProfile, isPromptBaseProfile, isPromptDeltaProfile, readMeta, saveMeta } from './meta.js';
import type { Preset, PromptBaseProfile, PromptDeltaProfile } from './meta.js';
import { applyProfileToPreset } from './promptToggle.js';
import { buildNewBaseProfile } from './profileMutators.js';
import { isArchiveProfile } from './profileActions.js';
import { lockDefaultSnapshot } from './presetSnapshot.js';
import { applyBufferedEdits, clearBufferedForName } from './presetBuffers.js';
import { mergeImportedProfiles } from './importExport.js';
import { assertV3ImportPayload } from './profileSchema.js';
import { getActiveProfile, setActiveProfile } from './activeProfile.js';
import { fastApplyPreset } from './fastApply.js';
import { getCardsTemplateContext } from './presetList.js';
import type { CardsContext } from './presetCardsContext.js';
import { clearImageCache, applyCachedBackgrounds } from './cache.js';

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
        .filter((p) => (isPromptBaseProfile(p) || isPromptDeltaProfile(p)) && !(isPromptBaseProfile(p) && isArchiveProfile(p)))
        .map((p) => ({ id: String(p.id), name: p.name || String(p.id) }));
}

/** 列出所有含 preset-cards profile 的预设名。 */
export function listPresetsWithProfiles(): string[] {
    return Object.keys(openai_setting_names).filter((name) => getPresetProfiles(name).length > 0);
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
    // 与 UI 一致：archive（隐藏 base）不可通过此入口加载
    if (isPromptBaseProfile(profile) && isArchiveProfile(profile)) return false;
    applyProfileToPreset(preset, profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[], { showMissingToast: true });
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

/** 加载 profile 到 preset（卡片行与 concise 弹窗共用）。
 * opts.closePopup：加载后关闭 concise 弹窗（仅弹窗内行点击传入）。 */
export async function loadProfile(
    ctx: CardsContext,
    name: string,
    idx: number,
    profileId: string,
    opts?: { closePopup?: boolean },
): Promise<void> {
    if (!await applyProfileToPresetByName(name, profileId)) return;
    toastr.success(L('Configuration loaded'));
    activatePreset(ctx, name, idx);
    clearBufferedForName(name, ctx.sessionEdits, ctx.pendingToggles);
    if (opts?.closePopup) {
        $('.popup:visible .popup-controls .menu_button').click();
    }
    await refreshGrid(ctx);
}

/** 整卡列表重渲染并触发搜索过滤。 */
export async function refreshGrid(ctx: CardsContext, opts?: { applyBackgrounds?: boolean }): Promise<void> {
    const searchEl = ctx.dialog.find('#preset_cards_search');
    const query = String(searchEl.val() ?? '');
    const newHtml = await renderExtensionTemplateAsync(EXTENSION_NAME, 'cards', getCardsTemplateContext());
    ctx.dialog.html($(newHtml).html());
    if (opts?.applyBackgrounds !== false) applyCachedBackgrounds(ctx.dialog);
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
        const profiles = Array.isArray(meta.profiles) ? meta.profiles : [];

        // 新 base 快照须包含本会话缓冲的开关/值编辑：先统一应用缓冲再采集快照
        const missing = applyBufferedEdits(preset, name, ctx.sessionEdits, ctx.pendingToggles);
        if (missing.length > 0) {
            toastr.warning(`${L('Missing prompts skipped')}: ${missing.join(', ')}`);
        }

        // 副本模式：saveMeta 持久化含新 base 的 nextMeta，成功后才写回活 meta（失败重试不重复产生 base）
        const nextProfiles = [...profiles, buildNewBaseProfile(preset, meta.defaultSnapshot, profileName)];
        const nextMeta = { ...meta, profiles: nextProfiles };
        await saveMeta(name, idx, nextMeta);
        meta.profiles = nextProfiles;
    } catch (err) {
        console.error('Add base failed', err);
        toastr.error(L('Failed to save preset metadata'));
        return;
    }
    toastr.success(L('Base profile saved'));
    await refreshGrid(ctx);
}

/** 导出完整 preset JSON（剔除敏感连接字段）。 */
export function exportPresetFile(name: string, idx: number): void {
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
    download(JSON.stringify(preset, null, 4), `${name}.json`, 'application/json');
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
        if (isArchiveProfile(p as PromptBaseProfile)) return;
        const row = $('<div class="preset_card_profile_row" style="cursor:pointer; padding:10px 14px; margin-bottom:4px;"></div>')
            .attr('data-profile-id', String(p.id));
        row.append($('<div class="preset_card_profile_name" style="font-size:14px;"></div>').text(p.name));

        row.on('click', async function () {
            await loadProfile(ctx, name, idx, String(row.data('profile-id')), { closePopup: true });
        });

        list.append(row);
    });

    container.append(list);
    callGenericPopup(container, POPUP_TYPE.TEXT, '', { wide: false, large: false });
}

/** 导入 profile 文件：读取 → JSON 校验 → 取名 → 迁移合并 → 落盘 → 刷新。file input 由调用方提供。 */
export async function importProfileFile(ctx: CardsContext, name: string, idx: number, file: File): Promise<void> {
    let parsed: Record<string, any>;
    try {
        const text = await file.text();
        parsed = JSON.parse(text) as Record<string, any>;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('Imported configuration is not a JSON object');
        }
        // fv3 base/delta/tree 载荷（有 kind）用 schema 校验，防畸形条目入库后崩溃；v1 快照（无 kind）走迁移分支。
        if (parsed.kind !== undefined) {
            assertV3ImportPayload(parsed);
        }
    } catch (err) {
        console.error(err);
        toastr.error(L('Failed to parse configuration file'));
        return;
    }
    try {
        let defaultName = file.name.replace(/\.json$/i, '');
        const profileName = await Popup.show.input(L('Configuration name:'), defaultName, defaultName);
        if (!profileName) return;

        const preset = openai_settings[idx] as Preset;
        // 首次导入：先采集出厂基线（lockDefaultSnapshot 内部幂等判 defaultSnapshotLocked）
        await lockDefaultSnapshot(preset, name, idx);
        const lockedMeta = readMeta(preset);
        const { profiles, warnings, archiveBaseId } = mergeImportedProfiles(parsed, lockedMeta.profiles, profileName, lockedMeta);
        for (const warning of warnings) toastr.warning(warning);
        // 副本模式：saveMeta 持久化 nextMeta，成功后才写回活 meta（失败重试不重复导入）
        const nextMeta = { ...lockedMeta, profiles };
        if (archiveBaseId) nextMeta.archiveBaseId = archiveBaseId;
        await saveMeta(name, idx, nextMeta);
        lockedMeta.profiles = profiles;
        if (archiveBaseId) lockedMeta.archiveBaseId = archiveBaseId;
        toastr.success(L('Configuration saved'));
        await refreshGrid(ctx, { applyBackgrounds: true });
        ctx.dialog.find(`.preset_card[data-preset-name="${name}"]`).find('.preset_card_profile_group').addClass('expanded');
    } catch (err) {
        console.error(err);
        toastr.error(L('Failed to save preset metadata'));
    }
}
