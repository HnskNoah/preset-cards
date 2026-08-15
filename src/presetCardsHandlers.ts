import { oai_settings, openai_settings, openai_setting_names } from '@sillytavern/scripts/openai';
import { POPUP_TYPE, callGenericPopup, Popup } from '@sillytavern/scripts/popup';
import { t } from '@sillytavern/scripts/i18n';
import { L } from './i18n.js';
import { getProfile, isPromptBaseProfile, isPromptDeltaProfile, persistMetaTransaction, readMeta } from './meta.js';
import type { Preset, PromptBaseProfile, PromptDeltaProfile } from './meta.js';
import { captureExtra, captureModel, captureSampling, diffExtra, diffSampling, resolveEffectiveExtra, resolveEffectiveSampling } from './promptToggle.js';
import { buildDerivedProfile, collectAncestorProfileIds, collectDescendantProfileIds } from './profileActions.js';
import { resetProfileCore } from './profileMutators.js';
import { chooseFromOptions } from './importExport.js';
import { openEditModal } from './editModal.js';
import { clearBufferedForName } from './presetBuffers.js';
import { openProfileEditorPopup } from './profileEditor.js';
import { getActiveProfile, setActiveProfile } from './activeProfile.js';
import { fastApplyPreset } from './fastApply.js';
import { addBaseProfile, clearImageCacheAndRefresh, deletePresetByName, exportPresetFile, importPresetFromHeader, importProfileFile, loadProfile, pickJsonFile, refreshActiveCardSelection, refreshActivePresetUI, refreshGrid, reselectFirstPreset, showConciseProfilesModal } from './presetCardsState.js';
import { refreshCardInPlace } from './presetCardsRender.js';
import type { CardsContext } from './presetCardsContext.js';

function updateCount(ctx: CardsContext, visible: number, total: number): void {
    const el = ctx.dialog.find('#preset_cards_count');
    el.text(visible === total ? `${total} ${L('presets')}` : `${visible} / ${total}`);
}

/** P3：把浏览态 store 派生到卡片页 DOM（批量按钮/class/已选高亮），并同步 ctx 兼容字段。 */
function applyBatchView(ctx: CardsContext): void {
    const s = ctx.presetStore.getState();
    ctx.isBatchMode = s.isBatchMode;
    ctx.batchSelectedCards = new Set(s.selectedIds);
    ctx.dialog.find('#preset_cards_multiselect_btn').toggleClass('active', s.isBatchMode);
    ctx.dialog.toggleClass('preset_cards_batch_mode', s.isBatchMode);
    ctx.dialog.find('#preset_cards_batch_delete_btn').toggleClass('hidden', !s.isBatchMode);
    ctx.dialog.find('.preset_card').removeClass('batch_selected');
    for (const name of s.selectedIds) {
        ctx.dialog.find(`.preset_card[data-preset-name="${name}"]`).addClass('batch_selected');
    }
}

/** 从事件目标提取 profile 行上下文（row + card + profileId + name + idx）。 */
function rowContext(el: JQuery<HTMLElement>): { card: JQuery<HTMLElement>; profileId: string; name: string; idx: number } {
    const row = el.closest('.preset_card_profile_row');
    const card = el.closest('.preset_card');
    return {
        card,
        profileId: String(row.data('profile-id')),
        name: card.attr('data-preset-name') as string,
        idx: card.data('preset-index') as number,
    };
}

/** 从事件目标提取卡片上下文（card + name + idx）。 */
function cardContext(el: JQuery<HTMLElement>): { card: JQuery<HTMLElement>; name: string; idx: number } {
    const card = el.closest('.preset_card');
    return {
        card,
        name: card.attr('data-preset-name') as string,
        idx: card.data('preset-index') as number,
    };
}

/** 绑定全部卡片页事件 handler（逻辑下沉 state，本文件仅做 DOM 绑定）。 */
export function bindCardsHandlers(ctx: CardsContext): void {
    // ---- Search ----
    ctx.dialog.on('input', '#preset_cards_search', function () {
        const q = String($(this).val()).toLowerCase().trim();
        ctx.presetStore.dispatch({ type: 'SET_SEARCH', query: q });
        let vis = 0;
        ctx.dialog.find('.preset_card').each(function () {
            const name = String($(this).data('preset-name')).toLowerCase();
            const desc = $(this).find('.preset_card_desc').text().toLowerCase();
            const match = !q || name.includes(q) || desc.includes(q);
            $(this).toggle(match);
            if (match) vis++;
        });
        const emptyEl = ctx.dialog.find('#preset_cards_empty');
        if (vis === 0 && emptyEl.length === 0) {
            ctx.dialog.find('#preset_cards_grid').append(
                `<div id="preset_cards_empty">${t`No presets found`}</div>`,
            );
        }
        ctx.dialog.find('#preset_cards_empty').toggle(vis === 0);
        updateCount(ctx, vis, ctx.presets.length);
    });

    // ---- Long press for Concise Mode Profiles ----
    ctx.dialog.on('mousedown touchstart', '.preset_card', function (e) {
        if (!ctx.isConciseMode || ctx.isBatchMode) return;
        if (e.type === 'mousedown' && (e as JQuery.MouseDownEvent).which !== 1) return;
        const card = $(this);
        ctx.pressTimer = window.setTimeout(function () {
            card.data('long-pressed', true);
            void showConciseProfilesModal(ctx, card);
        }, 600);
    });
    ctx.dialog.on('mousemove touchmove', '.preset_card', function () {
        if (ctx.pressTimer !== undefined) { clearTimeout(ctx.pressTimer); ctx.pressTimer = undefined; }
    });
    ctx.dialog.on('mouseup touchend mouseleave', '.preset_card', function () {
        if (ctx.pressTimer !== undefined) { clearTimeout(ctx.pressTimer); ctx.pressTimer = undefined; }
    });
    ctx.dialog.on('contextmenu', '.preset_card', function (e) {
        if (ctx.isConciseMode && !ctx.isBatchMode && $(this).data('long-pressed')) {
            e.preventDefault();
        }
    });

    // ---- Card click → switch preset or batch select ----
    ctx.dialog.on('click', '.preset_card', function (e) {
        if ($(this).data('long-pressed')) {
            $(this).data('long-pressed', false);
            return;
        }
        if ($(e.target as Element).closest('.preset_card_actions').length) return;
        if ($(e.target as Element).closest('.preset_card_profiles_section').length) return;

        const name = $(this).attr('data-preset-name') as string;
        if (ctx.isBatchMode) {
            ctx.presetStore.dispatch({ type: 'TOGGLE_SELECT', name });
            applyBatchView(ctx);
            return;
        }

        const idx = $(this).data('preset-index') as number;
        ctx.dialog.find('.preset_card').removeClass('selected');
        $(this).addClass('selected');
        ctx.presetStore.dispatch({ type: 'SET_ACTIVE', name });
        void fastApplyPreset(idx, name);
        toastr.success(`${t`Switched to`} ${name}`);
    });

    // ---- Clear Cache button ----
    ctx.dialog.on('click', '#preset_cards_clear_cache_btn', async function () {
        await clearImageCacheAndRefresh(ctx);
    });

    // ---- Edit button ----
    ctx.dialog.on('click', '.preset_card_edit_btn', function (e) {
        e.stopPropagation();
        const name = $(this).data('preset-name') as string;
        const idx = $(this).data('preset-index') as number;

        openEditModal(name, idx, async () => {
            refreshActivePresetUI(name);
            refreshCardInPlace(ctx, idx);
        });
    });

    // ---- Export button ----
    ctx.dialog.on('click', '.preset_card_export_btn', async function (e) {
        e.stopPropagation();
        const name = $(this).attr('data-preset-name') as string;
        const idx = $(this).data('preset-index') as number;
        const fileName = await Popup.show.input(L('Export file name:'), name, name);
        if (!fileName) return;
        exportPresetFile(name, idx, undefined, fileName);
    });

    // ---- Delete button ----
    ctx.dialog.on('click', '.preset_card_delete_btn', async function (e) {
        e.stopPropagation();
        const nameToDelete = $(this).attr('data-preset-name') as string;
        const confirm = await callGenericPopup(t`Delete the preset? This action is irreversible and your current settings will be overwritten.`, POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        const deleted = await deletePresetByName(ctx, nameToDelete, {
            activeHandling: 'immediate',
            emitLog: 'Error emitting PRESET_DELETED',
            onDeleted: () => toastr.success(t`Preset deleted`),
            onBeforeEmit: () => {
                ctx.dialog.find('#preset_cards_search').trigger('input');
                refreshActiveCardSelection(ctx);
            },
        });
        if (!deleted) {
            toastr.warning(t`Preset was not deleted from server`);
        }
    });

    // ---- Concise Mode toggle ----
    ctx.dialog.on('click', '#preset_cards_concise_btn', function () {
        ctx.isConciseMode = !ctx.isConciseMode;
        $(this).toggleClass('active', ctx.isConciseMode);
        ctx.dialog.toggleClass('preset_cards_concise_mode', ctx.isConciseMode);
        localStorage.setItem('preset_cards_concise', String(ctx.isConciseMode));
    });

    // ---- Multi-select toggle ----
    ctx.dialog.on('click', '#preset_cards_multiselect_btn', function () {
        ctx.presetStore.dispatch({ type: 'TOGGLE_BATCH_MODE' });
        if (!ctx.presetStore.getState().isBatchMode) {
            ctx.presetStore.dispatch({ type: 'CLEAR_SELECT' });
        }
        applyBatchView(ctx);
    });

    // ---- Batch Delete button ----
    ctx.dialog.on('click', '#preset_cards_batch_delete_btn', async function () {
        const selected = [...ctx.presetStore.getState().selectedIds];
        if (selected.length === 0) {
            toastr.info(t`No presets selected`);
            return;
        }
        const confirm = await callGenericPopup(t`Delete ${selected.length} presets? This action is irreversible.`, POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        let activeDeleted = false;
        let deletedCount = 0;
        for (const nameToDelete of selected) {
            if (openai_setting_names[nameToDelete] === undefined) continue;
            const wasActive = oai_settings.preset_settings_openai === nameToDelete;
            const deleted = await deletePresetByName(ctx, nameToDelete, {
                activeHandling: 'deferred',
                emitLog: 'Error emitting PRESET_DELETED for batch mode',
            });
            if (deleted) deletedCount++;
            if (wasActive) activeDeleted = true;
        }
        if (activeDeleted) {
            reselectFirstPreset();
            refreshActiveCardSelection(ctx);
        }
        if (deletedCount > 0) {
            toastr.success(t`${deletedCount} presets deleted`);
            ctx.dialog.find('#preset_cards_search').trigger('input');
        }
        // Exit batch mode（直接走 store，不用合成 click）
        ctx.presetStore.dispatch({ type: 'CLEAR_SELECT' });
        if (ctx.presetStore.getState().isBatchMode) {
            ctx.presetStore.dispatch({ type: 'TOGGLE_BATCH_MODE' });
        }
        applyBatchView(ctx);
    });

    // ---- Profiles: Add Configuration (Save Base Profile) ----
    ctx.dialog.on('click', '.preset_card_add_profile_btn', async function (e) {
        e.stopPropagation();
        const { name, idx } = cardContext($(this));
        const profileName = await Popup.show.input(L('Base profile name:'), '');
        if (!profileName) return;
        await addBaseProfile(ctx, name, idx, profileName);
    });

    // ---- Profiles: Export All Configurations ----
    ctx.dialog.on('click', '.preset_card_export_all_btn', async function (e) {
        e.stopPropagation();
        const { name, idx } = cardContext($(this));
        const choice = await chooseFromOptions(L('Export configuration'), [[L('Export all configurations'), 'export']]);
        if (choice !== 'export') return;
        exportPresetFile(name, idx);
    });

    // ---- Profiles: 分组折叠切换 ----
    ctx.dialog.on('click', '.preset_card_profile_toggle', function (e) {
        e.stopPropagation();
        $(this).closest('.preset_card_profile_group').toggleClass('expanded');
    });

    // ---- Profiles: Load Configuration ----
    ctx.dialog.on('click', '.preset_card_profile_name', async function (e) {
        e.stopPropagation();
        const { profileId, name, idx } = rowContext($(this));
        await loadProfile(ctx, name, idx, profileId);
    });

    // ---- Profiles: Derive from Base ----
    ctx.dialog.on('click', '.preset_card_profile_derive', async function (e) {
        e.stopPropagation();
        const { profileId, name, idx } = rowContext($(this));
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
        // 副本模式事务：持久化含新 delta 的 nextMeta，成功后才写回活 meta（失败重试不重复产生 delta）
        const ok = await persistMetaTransaction(meta, (m) => {
            const profiles = Array.isArray(m.profiles) ? m.profiles : [];
            const allProfiles = profiles as (PromptBaseProfile | PromptDeltaProfile)[];
            const samplingDiff = diffSampling(captureSampling(preset), resolveEffectiveSampling(parent, allProfiles, m.defaultSampling));
            const extraDiff = diffExtra(captureExtra(preset as Record<string, unknown>), resolveEffectiveExtra(parent, allProfiles, m.defaultExtra));
            return {
                ...m,
                profiles: [...profiles, buildDerivedProfile(parent, deltaName, [], samplingDiff ?? undefined, undefined, captureModel(preset) ?? undefined, extraDiff ?? undefined)],
            };
        }, name, idx);
        if (!ok) return;
        toastr.success(L('Derived profile created'));
        await refreshGrid(ctx);
        ctx.dialog.find(`.preset_card_profile_row[data-profile-id="${String(parent.id)}"]`).parents('.preset_card_profile_group').addClass('expanded');
    });

    // ---- Profiles: Reset to parent ----
    ctx.dialog.on('click', '.preset_card_profile_reset', async function (e) {
        e.stopPropagation();
        const { profileId, name, idx } = rowContext($(this));

        const confirm = await callGenericPopup(L('Reset this configuration to its parent?'), POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile) return;
        if (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile)) {
            toastr.warning(L('This profile type cannot be reset'));
            return;
        }

        try {
            const result = await resetProfileCore(preset, meta, profile, name, idx);
            if (result !== 'reset') return;
        } catch (err) {
            console.error('Reset failed', err);
            toastr.error(L('Failed to save preset metadata'));
            return;
        }
        refreshActivePresetUI(name);
        clearBufferedForName(name, ctx.sessionEdits, ctx.pendingToggles);
        await refreshGrid(ctx);
    });

    // ---- Profiles: Delete Configuration (级联) ----
    ctx.dialog.on('click', '.preset_card_profile_delete', async function (e) {
        e.stopPropagation();
        const { profileId, name, idx } = rowContext($(this));

        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile) return;

        const descendantIds = collectDescendantProfileIds(meta, profileId);
        let confirmText = L('Delete this configuration?');
        if (descendantIds.length > 0) {
            const names = descendantIds.map((id) => getProfile(meta, id)?.name || id).join(', ');
            confirmText += `\n${L('This will also delete the following derived configurations')}: ${names}`;
        }
        const confirm = await callGenericPopup(confirmText, POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        const deleteIds = new Set([String(profileId), ...descendantIds]);
        // 副本模式事务：删除/级联结果先在 nextMeta 上计算，持久化成功后才写回活 meta 并清 activeProfile
        // （失败时内存与磁盘保持一致，不残留"已删但未落盘"的中间态）
        const ok = await persistMetaTransaction(meta, (m) => ({
            ...m,
            profiles: (m.profiles || []).filter(p => !deleteIds.has(String(p.id))),
        }), name, idx);
        if (!ok) return;
        const active = getActiveProfile();
        if (active && active.presetName === name && deleteIds.has(active.profileId)) {
            setActiveProfile(undefined);
        }
        await refreshGrid(ctx);
    });

    // ---- Profiles: Export Configuration ----
    ctx.dialog.on('click', '.preset_card_profile_export', async function (e) {
        e.stopPropagation();
        const { profileId, name, idx } = rowContext($(this));
        const choice = await chooseFromOptions(L('Export configuration'), [[L('Export'), 'export']]);
        if (choice !== 'export') return;
        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile) return;
        // 单 profile 导出：连带父链一起导出（delta 需真实父链才能正确解析），parent 链外 profile 不导出
        const ancestorIds = collectAncestorProfileIds(meta, profileId);
        exportPresetFile(name, idx, ancestorIds);
    });

    // ---- Profiles: Import Configuration ----
    ctx.dialog.on('click', '.preset_card_import_profile_btn', async function (e) {
        e.stopPropagation();
        const { name, idx } = cardContext($(this));
        const file = await pickJsonFile();
        if (!file) return;
        await importProfileFile(ctx, name, idx, file);
    });

    // ---- Profiles: Edit Configuration (open profile editor popup) ----
    ctx.dialog.on('click', '.preset_card_profile_edit', async function (e) {
        e.stopPropagation();
        const { profileId, name, idx } = rowContext($(this));

        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile) return;
        if (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile)) {
            toastr.warning(L('This profile type cannot be edited with switches'));
            return;
        }
        await openProfileEditorPopup(
            { sessionEdits: ctx.sessionEdits, pendingToggles: ctx.pendingToggles, refreshActivePresetUI, onGridRefresh: () => refreshGrid(ctx) },
            name,
            idx,
            profileId,
        );
    });

    // ---- Import button（插件接管文件读取，按类型分流）----
    ctx.dialog.on('click', '#preset_cards_import_btn', async function () {
        await importPresetFromHeader(ctx);
    });
}
