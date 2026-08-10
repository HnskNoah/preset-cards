import { getRequestHeaders } from '@sillytavern/script';
import { fastApplyPreset } from './fastApply.js';
import { renderExtensionTemplateAsync } from '@sillytavern/scripts/extensions';
import { oai_settings, openai_settings, openai_setting_names, settingsToUpdate, getChatCompletionPreset } from '@sillytavern/scripts/openai';
import { POPUP_TYPE, callGenericPopup, Popup } from '@sillytavern/scripts/popup';
import { t } from '@sillytavern/scripts/i18n';
import { download } from '@sillytavern/scripts/utils';
import { eventSource, event_types } from '@sillytavern/scripts/events';
import { AVAILABLE_MODELS, EXTENSION_NAME, LOGO_BASE } from './constants.js';
import { L } from './i18n.js';
import {
    isPromptBaseProfile,
    isPromptDeltaProfile,
    getProfile,
    newProfileId,
    readMeta,
    saveMeta,
    type Preset,
    type PromptBaseProfile,
    type PromptDeltaProfile,
} from './meta.js';
import {
    applyBaseProfile,
    applyProfileToPreset,
    buildBaseSnapshotDiff,
    resolveParentStates,
} from './promptToggle.js';
import {
    buildProfileExportData,
    buildTreeExportData,
    chooseFromOptions,
    chooseProfileExportAction,
    mergeImportedProfiles,
    warnV1ExcludedFromTreeExport,
} from './importExport.js';
import { buildPresetList, getCardsTemplateContext } from './presetList.js';
import { applyCachedBackgrounds, clearImageCache } from './cache.js';
import { openEditModal } from './editModal.js';
import { applyBufferedEdits, clearBufferedForName, type PromptEditBuffer } from './presetBuffers.js';
import { applyDefaultOriginalFields, lockDefaultSnapshot } from './presetSnapshot.js';
import { buildDerivedProfile, collectDescendantProfileIds } from './profileActions.js';
import { openProfileEditorPopup } from './profileEditor.js';
import { getActiveProfile, setActiveProfile } from './activeProfile.js';

export async function openPresetCards(): Promise<void> {
    let presets = buildPresetList();

    let isBatchMode = false;
    const batchSelectedCards = new Set<string>();
    let isConciseMode = localStorage.getItem('preset_cards_concise') === 'true';

    // 本次打开期间的值编辑记录：identifier → { 编辑前字段, 编辑后字段（累积目标值） }
    const sessionEdits = new Map<string, PromptEditBuffer>();

    // 本次打开期间的开关切换缓冲：identifier → 本次会话目标 enabled，仅记录被切换过的条目
    const pendingToggles = new Map<string, boolean>();

    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'cards', getCardsTemplateContext());
    const dialog = $(html);

    if (isConciseMode) {
        dialog.addClass('preset_cards_concise_mode');
        dialog.find('#preset_cards_concise_btn').addClass('active');
    }

    // ---- Helpers ----
    function updateCount(visible: number, total: number): void {
        const el = dialog.find('#preset_cards_count');
        el.text(visible === total ? `${total} ${L('presets')}` : `${visible} / ${total}`);
    }

    // 刷新当前活动预设的运行态：从内存 openai_settings 重载已保存状态（profile 编辑/重置后调用），
    // 走快路径 fastApplyPreset（内部含 render），不再触发原生 change 慢路径。
    function refreshActivePresetUI(presetName: string): void {
        if (oai_settings.preset_settings_openai === presetName) {
            const idx = openai_setting_names[presetName];
            if (idx !== undefined) void fastApplyPreset(idx, presetName);
        }
    }

    // 激活 preset 并刷新运行态（走快路径 fastApplyPreset，不触发原生 change 慢路径）。
    // 须在 saveMeta 落盘之后调用（fastApplyPreset 从内存 openai_settings 重载，不会冲掉已保存改动）。
    function activatePreset(name: string, idx: number): void {
        void fastApplyPreset(idx, name);
        refreshActiveCardSelection();
    }

    // 整卡列表重渲染并触发搜索过滤；重渲染后默认重新应用背景图（applyCachedBackgrounds 幂等，
    // 仅对缺失 background-image 的卡片生效，无需逐调用点传 applyBackgrounds）。
    async function refreshGrid(opts?: { applyBackgrounds?: boolean }): Promise<void> {
        const searchEl = dialog.find('#preset_cards_search');
        const query = String(searchEl.val() ?? '');
        const newHtml = await renderExtensionTemplateAsync(EXTENSION_NAME, 'cards', getCardsTemplateContext());
        dialog.html($(newHtml).html());
        if (opts?.applyBackgrounds !== false) applyCachedBackgrounds(dialog);
        if (query) dialog.find('#preset_cards_search').val(query);
        if (isConciseMode) dialog.find('#preset_cards_concise_btn').addClass('active');
        dialog.find('#preset_cards_search').trigger('input');
    }

    // 活动预设被删后重选第一个剩余预设并走快路径应用（无剩余时保持 null）。
    function reselectFirstPreset(): void {
        if (Object.keys(openai_setting_names).length) {
            const newActiveName = Object.keys(openai_setting_names)[0];
            oai_settings.preset_settings_openai = newActiveName;
            void fastApplyPreset(openai_setting_names[newActiveName], newActiveName);
        }
    }

    // 刷新卡片选中态：清空后按当前活动预设重新高亮对应卡片。
    function refreshActiveCardSelection(): void {
        dialog.find('.preset_card').removeClass('selected');
        const newActive = oai_settings.preset_settings_openai;
        if (newActive) {
            dialog.find('.preset_card').filter(function () {
                return $(this).attr('data-preset-name') === newActive;
            }).addClass('selected');
        }
    }

    // 删除单个 preset 的公共例程：移除下拉 option → 清 openai_setting_names → 活动预设置空/重选 →
    // 服务端删除 → 成功路径删卡 + presets filter + onBeforeEmit + emit PRESET_DELETED。
    // 返回服务端是否确认删除成功；value 缺失（防御：批删循环已提前跳过）返回 false 不提示。
    // activeHandling: 'immediate'（单删）活动预设被删时当场 reselectFirstPreset；
    //                 'deferred'（批删）只置空，重选由调用方在循环后统一执行。
    // onDeleted: 服务端确认成功后、UI 删卡前（单删：成功 toast）；
    // onBeforeEmit: 删卡与 presets filter 之后、emit 之前（单删：search 过滤 + 选中态刷新）。
    async function deletePresetByName(
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

        $(`#settings_preset_openai option[value="${value}"]`).remove();
        delete openai_setting_names[nameToDelete];

        if (oai_settings.preset_settings_openai === nameToDelete) {
            oai_settings.preset_settings_openai = null;
            if (opts.activeHandling === 'immediate') {
                reselectFirstPreset();
            }
        }

        const response = await fetch('/api/presets/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ apiId: 'openai', name: nameToDelete }),
        });

        if (!response.ok) return false;

        const active = getActiveProfile();
        if (active && active.presetName === nameToDelete) {
            setActiveProfile(undefined);
        }

        // V2：删除预设后清理其未提交缓冲（孤儿缓冲仅会在同一会话重建同名预设时被错误套用）
        clearBufferedForName(nameToDelete, sessionEdits, pendingToggles);

        opts.onDeleted?.();

        // Safely remove the card from the UI immediately
        dialog.find('.preset_card').filter(function () {
            return $(this).attr('data-preset-name') === nameToDelete;
        }).remove();

        // Re-evaluate counts and search
        presets = presets.filter(p => p.name !== nameToDelete);

        opts.onBeforeEmit?.();

        // Emit the event LAST to avoid being interrupted by other listeners
        try {
            await eventSource.emit(event_types.PRESET_DELETED, { apiId: 'openai', name: nameToDelete });
        } catch (err) {
            console.error(opts.emitLog, err);
        }

        return true;
    }

    // ---- Search ----
    dialog.on('input', '#preset_cards_search', function () {
        const q = String($(this).val()).toLowerCase().trim();
        let vis = 0;
        dialog.find('.preset_card').each(function () {
            const name = String($(this).data('preset-name')).toLowerCase();
            const desc = $(this).find('.preset_card_desc').text().toLowerCase();
            const match = !q || name.includes(q) || desc.includes(q);
            $(this).toggle(match);
            if (match) vis++;
        });
        const emptyEl = dialog.find('#preset_cards_empty');
        if (vis === 0 && emptyEl.length === 0) {
            dialog.find('#preset_cards_grid').append(
                `<div id="preset_cards_empty">${t`No presets found`}</div>`,
            );
        }
        dialog.find('#preset_cards_empty').toggle(vis === 0);
        updateCount(vis, presets.length);
    });

    // ---- Long press for Concise Mode Profiles ----
    let pressTimer: number | undefined;

    async function showConciseProfilesModal(card: JQuery<HTMLElement>): Promise<void> {
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;
        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);

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
                const profileId = row.data('profile-id');
                const profile = getProfile(meta, profileId);
                if (!profile) return;

                applyProfileToPreset(preset, profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]);

                await saveMeta(name, idx, meta);
                toastr.success(L('Configuration loaded'));
                setActiveProfile({ presetName: name, profileId: String(profileId) });

                activatePreset(name, idx);

                // 加载已整体覆盖 preset：清该预设的会话缓冲（与非简洁路径一致）
                clearBufferedForName(name, sessionEdits, pendingToggles);

                $(this).closest('.popup').find('.popup-controls .menu_button').click(); // close modal

                await refreshGrid();
            });

            list.append(row);
        });

        container.append(list);

        callGenericPopup(container, POPUP_TYPE.TEXT, '', {
            wide: false,
            large: false,
        });
    }

    dialog.on('mousedown touchstart', '.preset_card', function (e) {
        if (!isConciseMode || isBatchMode) return;
        if (e.type === 'mousedown' && (e as JQuery.MouseDownEvent).which !== 1) return; // Only left click

        const card = $(this);

        pressTimer = window.setTimeout(function () {
            card.data('long-pressed', true);
            showConciseProfilesModal(card);
        }, 600);
    });

    dialog.on('mousemove touchmove', '.preset_card', function () {
        clearTimeout(pressTimer);
    });

    dialog.on('mouseup touchend mouseleave', '.preset_card', function () {
        clearTimeout(pressTimer);
    });

    dialog.on('contextmenu', '.preset_card', function (e) {
        if (isConciseMode && !isBatchMode && $(this).data('long-pressed')) {
            e.preventDefault();
        }
    });

    // ---- Card click → switch preset or batch select ----
    dialog.on('click', '.preset_card', function (e) {
        // Ignore if long-pressed
        if ($(this).data('long-pressed')) {
            $(this).data('long-pressed', false);
            return;
        }

        // Ignore if clicking action buttons
        if ($(e.target as Element).closest('.preset_card_actions').length) return;

        // Ignore if clicking inside the profiles section (entries, names, blank row space)
        if ($(e.target as Element).closest('.preset_card_profiles_section').length) return;

        const name = $(this).attr('data-preset-name') as string;

        if (isBatchMode) {
            if (batchSelectedCards.has(name)) {
                batchSelectedCards.delete(name);
                $(this).removeClass('batch_selected');
            } else {
                batchSelectedCards.add(name);
                $(this).addClass('batch_selected');
            }
            return;
        }

        const idx = $(this).data('preset-index') as number;

        dialog.find('.preset_card').removeClass('selected');
        $(this).addClass('selected');

        void fastApplyPreset(idx, name);
        toastr.success(`${t`Switched to`} ${name}`);
    });

    // ---- Clear Cache button ----
    dialog.on('click', '#preset_cards_clear_cache_btn', async function () {
        const confirm = await callGenericPopup(L('Clear all cached background images?'), POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        await clearImageCache();
        toastr.success(L('Cache cleared successfully'));

        await refreshGrid({ applyBackgrounds: true });
    });

    // ---- Edit button ----
    dialog.on('click', '.preset_card_edit_btn', function (e) {
        e.stopPropagation();
        const name = $(this).data('preset-name') as string;
        const idx = $(this).data('preset-index') as number;

        openEditModal(name, idx, async () => {
            // Refresh the card in-place
            const preset = openai_settings[idx] as Preset;
            const meta = readMeta(preset);
            const card = dialog.find(`.preset_card[data-preset-index="${idx}"]`);

            // Update description
            if (meta.description) {
                let descEl = card.find('.preset_card_desc');
                if (descEl.length === 0) {
                    card.find('.preset_card_body').prepend('<div class="preset_card_desc"></div>');
                    descEl = card.find('.preset_card_desc');
                }
                descEl.text(meta.description).attr('title', meta.description);
            } else {
                card.find('.preset_card_desc').remove();
            }

            // Update model chips
            const chipsEl = card.find('.preset_card_tags');
            chipsEl.empty();
            if (meta.models.length > 0) {
                if (chipsEl.length === 0) {
                    // Insert it before the profiles section so chips don't get buried.
                    const profilesEl = card.find('.preset_card_profiles_section');
                    if (profilesEl.length > 0) {
                        profilesEl.before('<div class="preset_card_tags"></div>');
                    } else {
                        card.find('.preset_card_body').append('<div class="preset_card_tags"></div>');
                    }
                }
                for (const mid of meta.models) {
                    const def = AVAILABLE_MODELS.find(m => m.id === mid);
                    const logoHtml = def ? `<img src="${LOGO_BASE + def.logo}" alt="" />` : '';
                    const label = def ? def.label : mid;
                    card.find('.preset_card_tags').append(
                        `<span class="preset_card_chip" title="${label}">${logoHtml}${label}</span>`,
                    );
                }
            } else {
                chipsEl.remove();
            }

            // Update background image
            const bgImage = meta.bgImage || '';
            card.toggleClass('has_bg', !!bgImage);
            let bgEl = card.find('.preset_card_bg_image');
            if (bgImage) {
                if (bgEl.length === 0) {
                    card.append('<div class="preset_card_bg_image"></div>');
                    bgEl = card.find('.preset_card_bg_image');
                }
                bgEl.css('background-image', 'none').attr('data-bg-url', bgImage);
                applyCachedBackgrounds(card);
            } else {
                bgEl.remove();
            }
        });
    });

    // 导出完整预设 JSON（剔除敏感字段与连接数据），卡片头部导出按钮专用。
    // 与配置区头部的「导出全部配置」(`${name}-tree.json`，整棵分支树) 区分。
    function exportPresetFile(name: string, idx: number): void {
        const preset = structuredClone(openai_settings[idx] as Preset);

        const sensitiveFields = [
            'reverse_proxy', 'proxy_password', 'custom_url',
            'custom_include_body', 'custom_exclude_body', 'custom_include_headers',
            'vertexai_region', 'vertexai_express_project_id',
            'azure_base_url', 'azure_deployment_name',
            'workers_ai_account_id',
        ];
        sensitiveFields.forEach(field => delete preset[field]);

        if (settingsToUpdate) {
            for (const [, [, settingName, , isConnection]] of Object.entries(settingsToUpdate)) {
                if (isConnection) { delete preset[settingName]; }
            }
        }

        download(JSON.stringify(preset, null, 4), `${name}.json`, 'application/json');
    }

    // ---- Export button (导出完整预设，剔除敏感字段) ----
    dialog.on('click', '.preset_card_export_btn', function (e) {
        e.stopPropagation();
        const name = $(this).attr('data-preset-name') as string;
        const idx = $(this).data('preset-index') as number;

        exportPresetFile(name, idx);
    });

    // ---- Delete button ----
    dialog.on('click', '.preset_card_delete_btn', async function (e) {
        e.stopPropagation();
        const nameToDelete = $(this).attr('data-preset-name') as string;

        const confirm = await callGenericPopup(t`Delete the preset? This action is irreversible and your current settings will be overwritten.`, POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        const deleted = await deletePresetByName(nameToDelete, {
            activeHandling: 'immediate',
            emitLog: 'Error emitting PRESET_DELETED',
            onDeleted: () => toastr.success(t`Preset deleted`),
            onBeforeEmit: () => {
                dialog.find('#preset_cards_search').trigger('input');
                refreshActiveCardSelection();
            },
        });

        if (!deleted) {
            toastr.warning(t`Preset was not deleted from server`);
        }
    });

    // ---- Concise Mode toggle ----
    dialog.on('click', '#preset_cards_concise_btn', function () {
        isConciseMode = !isConciseMode;
        $(this).toggleClass('active', isConciseMode);
        dialog.toggleClass('preset_cards_concise_mode', isConciseMode);
        localStorage.setItem('preset_cards_concise', String(isConciseMode));
    });

    // ---- Multi-select toggle ----
    dialog.on('click', '#preset_cards_multiselect_btn', function () {
        isBatchMode = !isBatchMode;
        $(this).toggleClass('active', isBatchMode);
        dialog.toggleClass('preset_cards_batch_mode', isBatchMode);

        if (isBatchMode) {
            dialog.find('#preset_cards_batch_delete_btn').removeClass('hidden');
        } else {
            dialog.find('#preset_cards_batch_delete_btn').addClass('hidden');
            batchSelectedCards.clear();
            dialog.find('.preset_card').removeClass('batch_selected');
        }
    });

    // ---- Batch Delete button ----
    dialog.on('click', '#preset_cards_batch_delete_btn', async function () {
        if (batchSelectedCards.size === 0) {
            toastr.info(t`No presets selected`);
            return;
        }

        const confirm = await callGenericPopup(t`Delete ${batchSelectedCards.size} presets? This action is irreversible.`, POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        let activeDeleted = false;
        let deletedCount = 0;

        for (const nameToDelete of batchSelectedCards) {
            if (openai_setting_names[nameToDelete] === undefined) continue;
            const wasActive = oai_settings.preset_settings_openai === nameToDelete;
            const deleted = await deletePresetByName(nameToDelete, {
                activeHandling: 'deferred',
                emitLog: 'Error emitting PRESET_DELETED for batch mode',
            });
            if (deleted) deletedCount++;
            if (wasActive) activeDeleted = true;
        }

        if (activeDeleted) {
            reselectFirstPreset();
            refreshActiveCardSelection();
        }

        if (deletedCount > 0) {
            toastr.success(t`${deletedCount} presets deleted`);
            dialog.find('#preset_cards_search').trigger('input');
        }

        // Exit batch mode
        dialog.find('#preset_cards_multiselect_btn').trigger('click');
    });

    // ---- Profiles: Add Configuration (Save Base Profile) ----
    dialog.on('click', '.preset_card_add_profile_btn', async function (e) {
        e.stopPropagation();
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;

        const profileName = await Popup.show.input(L('Base profile name:'), '');
        if (!profileName) return;

        const preset = openai_settings[idx] as Preset;

        if (oai_settings.preset_settings_openai === name) {
            // 与 ST #update_oai_preset 全量保存语义一致：getChatCompletionPreset(oai_settings) 生成完整 preset 主体
            // 回写 preset 内存（覆盖 prompts 及 temperature 等非 prompt 设置），prompt_order 独立同步；
            // 不再触发 #update_oai_preset + 固定 sleep：慢网下保存未完成会采到旧状态，且并发双 POST 有 last-write-wins 竞态。
            const presetBody = getChatCompletionPreset(oai_settings);
            Object.assign(preset, presetBody);
            if (Array.isArray(oai_settings.prompt_order)) {
                preset.prompt_order = structuredClone(oai_settings.prompt_order);
            }
        }

        // 首次对该预设 add base：先全量锁定默认基线（编辑前状态），幂等。reset 与 add base 基线 diff 都依赖它。
        await lockDefaultSnapshot(preset, name, idx);

        const meta = readMeta(preset);
        const profiles = Array.isArray(meta.profiles) ? meta.profiles : [];

        // 新 base 快照须包含本会话缓冲的开关/值编辑：先统一应用缓冲再采集快照
        const missing = applyBufferedEdits(preset, name, sessionEdits, pendingToggles);
        if (missing.length > 0) {
            toastr.warning(`${L('Missing prompts skipped')}: ${missing.join(', ')}`);
        }

        // 与锁定基线做差异：fields 只存与基线不同的字段（content 差异进 base，又避免全量 content 快照）
        profiles.push({
            formatVersion: 2,
            kind: 'prompt_base',
            id: newProfileId(),
            name: profileName,
            prompts: buildBaseSnapshotDiff(preset, meta.defaultSnapshot),
        });

        meta.profiles = profiles;
        await saveMeta(name, idx, meta);
        toastr.success(L('Base profile saved'));

        // Refresh UI
        await refreshGrid();
    });

    // ---- Profiles: Export All Configurations (导出整棵分支树) ----
    dialog.on('click', '.preset_card_export_all_btn', async function (e) {
        e.stopPropagation();
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;

        const choice = await chooseFromOptions(L('Export configuration'), [[L('Export all configurations'), 'export']]);
        if (choice !== 'export') return;

        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        warnV1ExcludedFromTreeExport(meta);
        download(buildTreeExportData(meta), `${name}-tree.json`, 'application/json');
    });

    // ---- Profiles: Load Configuration (click = apply only; edit via pencil button) ----
    dialog.on('click', '.preset_card_profile_name', async function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const profileId = row.data('profile-id');
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;

        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile) return;

        applyProfileToPreset(preset, profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[], { showMissingToast: true });

        // 记录最近加载的 profile 为激活（卡片页选中框特效，全局唯一，localStorage 持久化）
        setActiveProfile({ presetName: name, profileId: String(profileId) });

        await saveMeta(name, idx, meta);
        toastr.success(L('Configuration loaded'));

        // 激活该 preset（若尚未激活）并触发原生 UI 重载
        activatePreset(name, idx);

        // 加载已整体覆盖 preset：本卡此前的未保存编辑已失去意义，清缓冲（其他卡的缓冲保留）
        clearBufferedForName(name, sessionEdits, pendingToggles);

        await refreshGrid();
    });

    // ---- Profiles: Derive from Base ----
    dialog.on('click', '.preset_card_profile_derive', async function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const profileId = row.data('profile-id');
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;

        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const parent = getProfile(meta, profileId);
        if (!parent) return;

        if (!isPromptBaseProfile(parent) && !isPromptDeltaProfile(parent)) {
            toastr.warning(L('Cannot derive from a legacy profile'));
            return;
        }

        const deltaName = await Popup.show.input(L('Derived profile name:'), '');
        if (!deltaName) return;

        const profiles = Array.isArray(meta.profiles) ? meta.profiles : [];
        profiles.push(buildDerivedProfile(parent, deltaName));

        meta.profiles = profiles;
        await saveMeta(name, idx, meta);
        toastr.success(L('Derived profile created'));

        // Refresh UI
        await refreshGrid();
    });

    // ---- Profiles: Reset to parent (delta -> base; base -> hidden default) ----
    dialog.on('click', '.preset_card_profile_reset', async function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const profileId = row.data('profile-id');
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;

        const confirm = await callGenericPopup(L('Reset this configuration to its parent?'), POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile) return;

        if (isPromptDeltaProfile(profile)) {
            // 派生：回退到其上级（base 或上层 delta）；若无上级则回退到隐藏默认
            const parentStates = resolveParentStates(profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]);
            if (parentStates.length > 0) {
                applyBaseProfile(preset, {
                    formatVersion: 2,
                    kind: 'prompt_base',
                    id: profile.baseId || 'parent',
                    name: 'Parent',
                    prompts: parentStates,
                });
                profile.changes = [];
            } else {
                if (!meta.defaultSnapshot || meta.defaultSnapshot.length === 0) {
                    toastr.warning(L('No default baseline available'));
                    return;
                }
                applyDefaultOriginalFields(preset, meta);
                const tmp: PromptBaseProfile = {
                    formatVersion: 2,
                    kind: 'prompt_base',
                    id: profile.baseId || 'default',
                    name: 'Default',
                    prompts: meta.defaultSnapshot,
                };
                applyBaseProfile(preset, tmp);
                profile.changes = [];
            }
            await saveMeta(name, idx, meta);
            toastr.success(L('Configuration reset'));
            refreshActivePresetUI(name);
            clearBufferedForName(name, sessionEdits, pendingToggles);
        } else if (isPromptBaseProfile(profile)) {
            // 主 profile：回退到隐藏默认基准
            if (!meta.defaultSnapshot || meta.defaultSnapshot.length === 0) {
                toastr.warning(L('No default baseline available'));
                return;
            }
            applyDefaultOriginalFields(preset, meta);
            // 只回写开关；originalFields 是 reset 专用元数据，不随 profile 持久化
            profile.prompts = structuredClone(meta.defaultSnapshot).map(({ identifier, enabled }) => ({ identifier, enabled }));
            const tmp: PromptBaseProfile = {
                formatVersion: 2,
                kind: 'prompt_base',
                id: profile.id,
                name: profile.name,
                prompts: meta.defaultSnapshot,
            };
            applyBaseProfile(preset, tmp);
            await saveMeta(name, idx, meta);
            toastr.success(L('Configuration reset'));
            refreshActivePresetUI(name);
            clearBufferedForName(name, sessionEdits, pendingToggles);
        } else {
            toastr.warning(L('This profile type cannot be reset'));
            return;
        }

        // Refresh UI
        await refreshGrid();
    });

    // ---- Profiles: Delete Configuration ----
    // 级联删除：删除 profile 时，递归收集所有派生后代（delta 的 delta……），一并删除。
    // 弹窗确认时列出将被删除的全部子 node 名称（多行、含嵌套），确认后整棵子树移除。
    dialog.on('click', '.preset_card_profile_delete', async function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const profileId = row.data('profile-id');
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;

        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile) return;

        const descendantIds = collectDescendantProfileIds(meta, profileId);

        let confirmText = L('Delete this configuration?');
        if (descendantIds.length > 0) {
            const names = descendantIds
                .map((id) => getProfile(meta, id)?.name || id)
                .join(', ');
            confirmText += `\n${L('This will also delete the following derived configurations')}: ${names}`;
        }

        const confirm = await callGenericPopup(confirmText, POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        const deleteIds = new Set([String(profileId), ...descendantIds]);
        meta.profiles = (meta.profiles || []).filter(p => !deleteIds.has(String(p.id)));
        const active = getActiveProfile();
        if (active && active.presetName === name && deleteIds.has(active.profileId)) {
            setActiveProfile(undefined);
        }
        await saveMeta(name, idx, meta);

        // 整棵子树可能跨多行，重建网格而非仅删当前行
        await refreshGrid();
    });

    // ---- Profiles: Export Configuration ----
    dialog.on('click', '.preset_card_profile_export', async function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const profileId = row.data('profile-id');
        const card = $(this).closest('.preset_card');
        const idx = card.data('preset-index') as number;
        const preset = openai_settings[idx] as Preset;

        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile) return;

        const choice = await chooseProfileExportAction();
        if (choice === 'tree') {
            // v1 快照无父链可导出，回退为单 profile 导出
            if (isPromptBaseProfile(profile) || isPromptDeltaProfile(profile)) {
                warnV1ExcludedFromTreeExport(meta);
                download(buildTreeExportData(meta, profile.id), `${profile.name}-tree.json`, 'application/json');
            } else {
                download(buildProfileExportData(profile, meta), `${profile.name}.json`, 'application/json');
            }
        } else if (choice === 'profile') {
            download(buildProfileExportData(profile, meta), `${profile.name}.json`, 'application/json');
        }
    });

    // ---- Profiles: Import Configuration ----
    dialog.on('click', '.preset_card_import_profile_btn', function (e) {
        e.stopPropagation();
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (event) => {
            const file = (event.target as HTMLInputElement).files?.[0];
            if (!file) return;

            try {
                const text = await file.text();
                const parsed = JSON.parse(text) as Record<string, any>;
                // 不可信输入形状防御：JSON 文件必须是对象（v1 settings 快照或带 kind 的 profile）。
                // null / 原始值 / 数组视为畸形文件，走 catch 报错，避免把非对象塞进 settings 生成垃圾 v1 profile。
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                    throw new Error('Imported configuration is not a JSON object');
                }

                let defaultName = file.name.replace(/\.json$/i, '');
                const profileName = await Popup.show.input(L('Configuration name:'), defaultName, defaultName);
                if (!profileName) return;

                const preset = openai_settings[idx] as Preset;
                const meta = readMeta(preset);
                const existing = Array.isArray(meta.profiles) ? meta.profiles : [];
                const { profiles, warnings } = mergeImportedProfiles(parsed, existing, profileName, meta.defaultSnapshot);
                for (const warning of warnings) {
                    toastr.warning(warning);
                }

                meta.profiles = profiles;
                await saveMeta(name, idx, meta);
                toastr.success(L('Configuration saved'));

                await refreshGrid({ applyBackgrounds: true });
            } catch (err) {
                console.error(err);
                toastr.error(L('Failed to parse configuration file'));
            }
        };
        input.click();
    });

    // ---- Profiles: Edit Configuration (open profile editor popup) ----
    dialog.on('click', '.preset_card_profile_edit', async function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const profileId = row.data('profile-id');
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;

        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile) return;

        // v1 快照无开关/值编辑界面，直接提示不可编辑
        if (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile)) {
            toastr.warning(L('This profile type cannot be edited with switches'));
            return;
        }

        await openProfileEditorPopup(
            { sessionEdits, pendingToggles, refreshActivePresetUI, onGridRefresh: () => refreshGrid() },
            name,
            idx,
            profileId,
        );
    });

    // ---- Import button ----
    dialog.on('click', '#preset_cards_import_btn', function () {
        $('#openai_preset_import_file').trigger('click');
        // Let SillyTavern's native import handler do the rest.
        // It will parse the file, save the preset, and switch to it.
        // We will just close the modal since a new preset was imported and the grid is now stale.
        dialog.closest('.popup').find('.popup-controls .menu_button').click();
    });

    updateCount(presets.length, presets.length);
    applyCachedBackgrounds(dialog);

    callGenericPopup(dialog, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
}
