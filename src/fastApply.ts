import { saveSettingsDebounced } from '@sillytavern/script';
import { cancelDebounce } from '@sillytavern/scripts/utils';
import { eventSource, event_types } from '@sillytavern/scripts/events';
import { oai_settings, openai_settings, promptManager, settingsToUpdate } from '@sillytavern/scripts/openai';
import type { Preset } from './meta.js';

/**
 * 快路径应用预设：绕过 ST 原生 onSettingsPresetChange（openai.js:4898-4959）里
 * 约 100 次 `$(selector).val(value).trigger('input')` 的逐个同步 reflow，改为：
 *  1. 直接写内存 oai_settings（不触发 DOM）；
 *  2. 批量直写 DOM 元素；
 *  3. 只触发必要全局事件（保存、PromptManager 刷新）。
 * 事件序列与原生实现保持一致（OAI_PRESET_CHANGED_BEFORE → … → OAI_PRESET_CHANGED_AFTER → PRESET_CHANGED）。
 * bind_preset_to_connection 开启时仍需完整 trigger 链，此路径同样补齐（与原生 openai.js:4946-4951 对齐）。
 */
export async function fastApplyPreset(presetIndex: number, presetName: string): Promise<void> {
    const preset = openai_settings[presetIndex] as Preset | undefined;
    if (!preset) return;

    const presetNameBefore = oai_settings.preset_settings_openai;
    oai_settings.preset_settings_openai = presetName;

    // ── Phase 1: 触发 BEFORE 事件（PromptManager 迁移依赖）──
    // 直接传 preset 引用，只读不写，无需克隆。
    await eventSource.emit(event_types.OAI_PRESET_CHANGED_BEFORE, {
        preset: preset,
        presetName: presetName,
        settingsToUpdate: settingsToUpdate,
        settings: oai_settings,
        savePreset: null, // 仅用于迁移；保存由本路径统一处理
        presetNameBefore: presetNameBefore,
    });

    // ── Phase 2: 直接写内存，跳过逐个 .val().trigger() ──
    for (const [key, [, settingName, , isConnection]] of Object.entries(settingsToUpdate)) {
        if (isConnection && !oai_settings.bind_preset_to_connection) {
            continue; // 未绑定连接时跳过连接字段（对齐原生 openai.js:4925-4927）
        }
        if (key === 'extensions') {
            oai_settings.extensions = preset.extensions || {};
            continue; // 扩展无对应 UI，直接写内存即可
        }
        if (preset[key] !== undefined) {
            // prompts / prompt_order 深拷贝隔离：防止运行时对象后续被外部改动后泄漏进存储的预设
            oai_settings[settingName] = (key === 'prompts' || key === 'prompt_order')
                ? structuredClone(preset[key])
                : preset[key];
        }
    }

    // ── Phase 3: 批量 DOM 直写 ──
    if (oai_settings.bind_preset_to_connection) {
        $('.model_custom_select').empty(); // 对齐原生 openai.js:4920-4922
    }

    for (const [key, [selector, , isCheckbox, isConnection]] of Object.entries(settingsToUpdate)) {
        if (isConnection && !oai_settings.bind_preset_to_connection) continue;
        if (!selector || selector === '' || selector === '#NULL_SELECTOR') continue;
        if (preset[key] === undefined) continue;

        const el = document.querySelector(selector);
        if (!el) continue;

        if (isCheckbox) {
            (el as HTMLInputElement).checked = !!preset[key];
        } else {
            (el as HTMLInputElement).value = preset[key];
        }

        // 同步 range 滑块的数字计数器（无需触发事件）
        if ((el as HTMLInputElement).type === 'range' && el.id) {
            const counter = document.querySelector(`input[type="number"][data-for="${el.id}"]`) as HTMLInputElement | null;
            if (counter) counter.value = String(Number(preset[key]));
        }
    }

    // 同步原生下拉选中项（仅写值，不触发 change，避免原生慢路径）
    const selectEl = document.querySelector('#settings_preset_openai') as HTMLSelectElement | null;
    if (selectEl) selectEl.value = String(presetIndex);

    // ── Phase 4: 连接相关特殊 trigger（对齐原生 openai.js:4946-4951）──
    if (oai_settings.bind_preset_to_connection) {
        $('#chat_completion_source').trigger('change');
        $('#openrouter_providers_chat').trigger('change');
        $('#openrouter_quantizations_chat').trigger('change');
        $('#nanogpt_provider').trigger('change');
    }

    // 轻量级：logit bias 预设（无条件触发，对齐原生 openai.js:4953）
    $('#openai_logit_bias_preset').trigger('change');

    // ── Phase 5: 必要全局事件 ──
    saveSettingsDebounced();

    await eventSource.emit(event_types.OAI_PRESET_CHANGED_AFTER);
    await eventSource.emit(event_types.PRESET_CHANGED, { apiId: 'openai', name: presetName });

    // PromptManager 刷新：先取消 BEFORE 事件监听器排入的延迟 render，
    // 再立即执行一次 render(false)（false 原生跳过干跑，无需 monkey-patch）。
    const pm = promptManager;
    if (pm) {
        cancelDebounce(pm.renderDebounced);
        pm.render(false);
    }
}
