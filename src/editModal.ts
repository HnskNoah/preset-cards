import { oai_settings, openai_settings, settingsToUpdate } from '@sillytavern/scripts/openai';
import { saveSettingsDebounced } from '@sillytavern/script';
import { renderExtensionTemplateAsync } from '@sillytavern/scripts/extensions';
import { POPUP_TYPE, POPUP_RESULT, callGenericPopup } from '@sillytavern/scripts/popup';
import { t } from '@sillytavern/scripts/i18n';
import { AVAILABLE_MODELS, EXTENSION_NAME, LOGO_BASE } from './constants.js';
import { readMeta, persistMetaTransaction, type Preset, type PromptFields } from './meta.js';
import { findPromptInPreset } from './promptToggle.js';
import { refreshProjectionRuntimeIfActive, syncPresetRegistrations } from './presetRegistration.js';
import { L } from './i18n.js';

/**
 * Open the edit modal for a preset.
 * @param onSaved  callback after saving so the card grid can refresh
 */
export async function openEditModal(presetName: string, presetIndex: number, onSaved?: () => void): Promise<void> {
    const preset = openai_settings[presetIndex] as Preset | undefined;
    if (!preset) return;

    const meta = readMeta(preset);

    // Build available models with selection state
    const availableModels = AVAILABLE_MODELS.map(m => ({
        ...m,
        logo: LOGO_BASE + m.logo,
        selected: meta.models.includes(m.id),
    }));

    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'edit', {
        presetName,
        description: meta.description,
        bgImage: meta.bgImage,
        availableModels,
        sampling: {
            temperature: preset['temperature'] != null ? String(preset['temperature']) : '',
            topP: preset['top_p'] != null ? String(preset['top_p']) : '',
            topK: preset['top_k'] != null ? String(preset['top_k']) : '',
            contextTokens: preset['openai_max_context'] != null ? String(preset['openai_max_context']) : '',
            maxTokens: preset['openai_max_tokens'] != null ? String(preset['openai_max_tokens']) : '',
            streaming: !!preset['stream_openai'],
            thoughts: !!preset['show_thoughts'],
        },
        i18n: {
            descTitle: L('Description'),
            descPlaceholder: L('Add a short description for this preset...'),
            modelsTitle: L('Applicable Models'),
            bgImageTitle: L('Background Image URL'),
            bgImagePlaceholder: L('e.g., https://example.com/bg.jpg'),
            samplingTitle: L('Sampling'),
            contextTitle: L('Context'),
            tokensTitle: L('Tokens'),
            streamTitle: L('Streaming'),
            thoughtsTitle: L('Request model reasoning'),
        }
    });

    const dialog = $(html);

    // Toggle model chips
    dialog.find('.preset_edit_model_option').on('click', function () {
        $(this).toggleClass('active');
    });

    const result = await callGenericPopup(dialog, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Save`,
        cancelButton: t`Cancel`,
        allowVerticalScrolling: true,
    });

    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    // Collect values
    const newDesc = dialog.find('#preset_edit_desc').val()?.toString().trim() || '';
    const newBgImage = dialog.find('#preset_edit_bg_image').val()?.toString().trim() || '';
    const newModels = dialog.find('.preset_edit_model_option.active').map(function () {
        return $(this).data('model-id') as string;
    }).get();

    // 采样参数：仅写非空值（空=保持原值）；stream 为显式布尔。
    const toNumOrUndef = (sel: string): number | undefined => {
        const raw = dialog.find(sel).val()?.toString().trim() ?? '';
        if (raw === '') return undefined;
        const n = Number(raw);
        return Number.isFinite(n) ? n : undefined;
    };
    const temp = toNumOrUndef('#preset_edit_temp');
    const topP = toNumOrUndef('#preset_edit_top_p');
    const topK = toNumOrUndef('#preset_edit_top_k');
    const context = toNumOrUndef('#preset_edit_context');
    const maxTokens = toNumOrUndef('#preset_edit_max_tokens');
    const streaming = dialog.find('#preset_edit_stream').is(':checked');
    const thoughts = dialog.find('#preset_edit_thoughts').is(':checked');

    // 采样参数随 meta 事务一并落盘（patch 模式）：请求体携带新值，成功后才写回活预设——
    // 保存失败时内存/磁盘/UI 三方保持一致，不残留「内存已改、磁盘未存」的分歧。
    const samplingPatch: Record<string, any> = { stream_openai: streaming, show_thoughts: thoughts };
    if (temp !== undefined) samplingPatch['temperature'] = temp;
    if (topP !== undefined) samplingPatch['top_p'] = topP;
    if (topK !== undefined) samplingPatch['top_k'] = topK;
    if (context !== undefined) samplingPatch['openai_max_context'] = context;
    if (maxTokens !== undefined) samplingPatch['openai_max_tokens'] = maxTokens;

    const ok = await persistMetaTransaction(meta, (m) => ({
        ...m,
        description: newDesc,
        models: newModels,
        bgImage: newBgImage,
    }), presetName, presetIndex, { patch: samplingPatch });
    if (!ok) return;
    // 活动预设：把采样补丁同步进 ST 运行时与面板 DOM（镜像 doSaveMeta 的 extensions 镜像语义）——
    // 否则当前会话不生效，且下次原生「保存预设」会用旧运行时值覆盖预设文件里的新值。
    if (oai_settings.preset_settings_openai === presetName) {
        for (const [presetKey, value] of Object.entries(samplingPatch)) {
            const meta = settingsToUpdate[presetKey];
            const settingsKey = meta ? meta[1] : presetKey;
            (oai_settings as Record<string, any>)[settingsKey] = value;
            if (!meta) continue;
            if (meta[2]) $(meta[0]).prop('checked', value === true);
            else $(meta[0]).val(value as number);
        }
        saveSettingsDebounced(); // 运行时变更随 ST 自身节奏落 settings.json,与原生面板改动同路径
    } else {
        // 当前活动项可能是本预设的注册投影（"父预设 - profile"）。编辑父预设的采样字段后，
        // 显式刷新投影记录并重应用活动投影，让 ST 原生勾选框无需手动再次激活即可跟随。
        syncPresetRegistrations(presetName, presetIndex);
        refreshProjectionRuntimeIfActive(presetName);
    }
    toastr.success(t`Preset updated`);
    if (onSaved) onSaved();
}

/** 单个 prompt 值编辑表单：表单容器 + 收集函数。
 * profile-editor 右栏内联编辑使用。
 * collectFields() 返回与基线（current）有净变化的字段；无变化返回 null。
 * 基线 current 为「预设原值叠加已缓冲编辑」的有效当前值；缺省以预设原值预填/比对。 */
export interface PromptEditForm {
    container: JQuery<HTMLElement>;
    collectFields: () => PromptFields | null;
}

/**
 * 构造单 prompt 值编辑表单（不弹窗，由调用方决定渲染位置）。
 * Position 下拉含 0=Relative / 1=In-chat / 2=In Chat Absolute Depth；
 * 选中 2 时显示 Injection Depth number 输入。
 * preset 中缺失该 prompt（防御路径）返回空表单，collectFields 恒 null。
 */
export function buildPromptEditForm(
    preset: Preset,
    identifier: string,
    current?: PromptFields,
    readonly?: boolean,
): PromptEditForm {
    const prompt = findPromptInPreset(preset, identifier);
    if (!prompt) {
        return {
            container: $('<div class="preset_cards_prompt_edit_form"></div>'),
            collectFields: () => null,
        };
    }

    const isMarker = !!prompt.marker;

    const nameVal = current?.name !== undefined ? current.name : (prompt.name ?? '');
    const roleVal = current?.role !== undefined ? current.role : (prompt.role ?? 'system');
    const contentVal = current?.content !== undefined ? current.content : (prompt.content ?? '');
    const positionVal = current?.injection_position !== undefined ? current.injection_position : (prompt.injection_position ?? 0);
    // ST DEFAULT_DEPTH=4（PromptManager.js:31）作为缺省显示值
    const depthVal = current?.injection_depth !== undefined ? current.injection_depth : (prompt.injection_depth ?? 4);

    const container = $('<div class="preset_cards_prompt_edit_form"></div>');

    if (isMarker) {
        container.append($('<div class="preset_cards_prompt_edit_marker_notice"></div>')
            .text(L('This is a marker prompt. Its content is managed by SillyTavern and cannot be edited here.')));
    }

    const nameWrap = $('<div class="preset_edit_field"></div>');
    nameWrap.append($('<label></label>').text(L('Name')));
    const nameInput = $('<input type="text">').val(nameVal);
    nameWrap.append(nameInput);

    // 位置与角色：两个窄控件并排一行，窄屏自动换行
    const rowWrap = $('<div class="preset_cards_prompt_edit_row"></div>');

    const roleWrap = $('<div class="preset_edit_field"></div>');
    roleWrap.append($('<label></label>').text(L('Role')));
    const roleSelect = $('<select class="text_pole"></select>');
    for (const [value, label] of [['system', L('System')], ['user', L('User')], ['assistant', L('AI Assistant')]] as [string, string][]) {
        const option = $('<option></option>').attr('value', value).text(label);
        if (value === roleVal) option.attr('selected', 'selected');
        roleSelect.append(option);
    }
    roleWrap.append(roleSelect);

    const positionWrap = $('<div class="preset_edit_field"></div>');
    positionWrap.append($('<label></label>').text(L('Position')));
    const positionSelect = $('<select class="text_pole"></select>');
    // 0=Relative, 1=In-chat, 2=In Chat Absolute Depth（含深度编辑）
    for (const [value, label] of [['0', L('Relative')], ['1', L('In-chat')], ['2', L('In Chat Absolute Depth')]] as [string, string][]) {
        const option = $('<option></option>').attr('value', value).text(label);
        if (value === String(positionVal)) option.attr('selected', 'selected');
        positionSelect.append(option);
    }
    positionWrap.append(positionSelect);

    rowWrap.append(roleWrap);
    rowWrap.append(positionWrap);

    // 注入深度：仅 position=2（In Chat Absolute Depth）时显示
    const depthWrap = $('<div class="preset_edit_field preset_cards_prompt_edit_depth" style="display:none;"></div>');
    depthWrap.append($('<label></label>').text(L('Injection Depth')));
    const depthInput = $('<input type="number" min="1" step="1">').val(depthVal);
    depthWrap.append(depthInput);
    positionSelect.on('change', function () {
        depthWrap.toggle(Number($(this).val()) === 2);
    });
    depthWrap.toggle(positionVal === 2);

    const contentWrap = $('<div class="preset_edit_field"></div>');
    contentWrap.append($('<label></label>').text(L('Content')));
    const contentInput = $('<textarea></textarea>').val(contentVal);
    if (isMarker) {
        contentInput.prop('disabled', true);
    }
    contentWrap.append(contentInput);

    container.append(nameWrap);
    container.append(rowWrap);
    container.append(depthWrap);
    container.append(contentWrap);

    // 只读查看（锁定态）：禁用全部控件
    if (readonly) {
        container.find('input, select, textarea').prop('disabled', true);
        container.addClass('preset_cards_prompt_edit_readonly');
    }

    // 只返回与当前值不同的字段，避免把默认值写进 profile
    const collectFields = (): PromptFields | null => {
        const fields: PromptFields = {};
        const role = String(roleSelect.val() ?? 'system');
        const name = String(nameInput.val() ?? '');
        const content = String(contentInput.val() ?? '');
        const position = Number(positionSelect.val() ?? 0);
        const depthRaw = String(depthInput.val() ?? depthVal);
        const depth = depthRaw === '' ? NaN : Number(depthRaw);

        if (role !== roleVal) fields.role = role;
        if (name !== nameVal) fields.name = name;
        if (!isMarker && content !== contentVal) fields.content = content;
        if (position !== positionVal) fields.injection_position = position;
        // 深度框为空时视为无效（Number('')===0 会误写 injection_depth:0），跳过不写入
        if (position === 2 && Number.isFinite(depth) && depth !== depthVal) fields.injection_depth = depth;

        return Object.keys(fields).length > 0 ? fields : null;
    };

    return { container, collectFields };
}
