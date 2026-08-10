import { saveSettingsDebounced } from '@sillytavern/script';
import { cancelDebounce } from '@sillytavern/scripts/utils';
import { eventSource, event_types } from '@sillytavern/scripts/events';
import { oai_settings, openai_settings, promptManager, settingsToUpdate, chat_completion_sources, custom_prompt_post_processing_types } from '@sillytavern/scripts/openai';
import { ToolManager } from '@sillytavern/scripts/tool-calling';
import type { Preset } from './meta.js';

/**
 * 快路径应用预设：绕过 ST 原生 onSettingsPresetChange（openai.js:4898-4959）里
 * 约 100 次 `$(selector).val(value).trigger('input')` 的逐个同步 reflow，改为：
 *  1. 直接写内存 oai_settings（不触发 DOM）；
 *  2. 批量直写 DOM 元素；
 *  3. 只触发必要全局事件（保存、PromptManager 刷新）。
 * 事件序列与原生实现保持一致（OAI_PRESET_CHANGED_BEFORE → … → OAI_PRESET_CHANGED_AFTER → PRESET_CHANGED）。
 * bind_preset_to_connection 开启时仍需完整 trigger 链，此路径同样补齐（与原生 openai.js:4946-4951 对齐）。
 * 另补原生快路径之外的两处必要同步（原生由 input 事件处理器驱动，此处直接写）：
 *  - legacy 字段迁移（migrateChatCompletionSettings，openai.js:4904-4907/4179-4212）；
 *  - ToolManager.RECURSE_LIMIT（openai.js:6919）。
 */

/**
 * 镜像 ST migrateChatCompletionSettings（openai.js:4180-4211）的 legacy 字段迁移表。
 * 原生每次切换预设都对克隆体迁移（openai.js:4904-4907），但迁移函数未导出，故按原表逐条镜像。
 * 就地迁移内存中的存储预设：幂等，且预设数组不经 saveSettings 落盘，不会污染磁盘数据。
 */
const CHARACTER_NAMES_BEHAVIOR = { NONE: -1, DEFAULT: 0, COMPLETION: 1, CONTENT: 2 } as const;

function migrateLegacyPresetFields(preset: Preset): void {
    const migrateMap: { oldKey: string; oldValue: unknown; newKey: string; newValue: unknown }[] = [
        { oldKey: 'names_in_completion', oldValue: true, newKey: 'names_behavior', newValue: CHARACTER_NAMES_BEHAVIOR.COMPLETION },
        { oldKey: 'chat_completion_source', oldValue: 'palm', newKey: 'chat_completion_source', newValue: chat_completion_sources.MAKERSUITE },
        { oldKey: 'custom_prompt_post_processing', oldValue: custom_prompt_post_processing_types.CLAUDE, newKey: 'custom_prompt_post_processing', newValue: custom_prompt_post_processing_types.MERGE },
        { oldKey: 'ai21_model', oldValue: /^j2-/, newKey: 'ai21_model', newValue: 'jamba-large' },
        { oldKey: 'image_inlining', oldValue: false, newKey: 'media_inlining', newValue: false },
        { oldKey: 'image_inlining', oldValue: true, newKey: 'media_inlining', newValue: true },
        { oldKey: 'video_inlining', oldValue: true, newKey: 'media_inlining', newValue: true },
        { oldKey: 'audio_inlining', oldValue: true, newKey: 'media_inlining', newValue: true },
        { oldKey: 'claude_use_sysprompt', oldValue: true, newKey: 'use_sysprompt', newValue: true },
        { oldKey: 'use_makersuite_sysprompt', oldValue: true, newKey: 'use_sysprompt', newValue: true },
        { oldKey: 'mistralai_model', oldValue: /^(mistral-medium|mistral-small)$/, newKey: 'mistralai_model', newValue: `${preset.mistralai_model}-latest` },
        { oldKey: 'deepseek_model', oldValue: /^deepseek-(chat|reasoner|coder)$/, newKey: 'deepseek_model', newValue: 'deepseek-v4-flash' },
        { oldKey: 'openrouter_sort_models', oldValue: 'alphabetically', newKey: 'sort_models', newValue: 'alphabetically' },
        { oldKey: 'openrouter_sort_models', oldValue: 'pricing.prompt', newKey: 'sort_models', newValue: 'pricing.prompt' },
        { oldKey: 'openrouter_sort_models', oldValue: 'context_length', newKey: 'sort_models', newValue: 'context_length' },
        { oldKey: 'openrouter_group_models', oldValue: true, newKey: 'group_models', newValue: true },
    ];
    for (const migration of migrateMap) {
        if (!Object.hasOwn(preset, migration.oldKey)) continue;
        const shouldMigrate = migration.oldValue instanceof RegExp
            ? migration.oldValue.test(String(preset[migration.oldKey]))
            : preset[migration.oldKey] === migration.oldValue;
        if (shouldMigrate) preset[migration.newKey] = migration.newValue;
        if (migration.oldKey !== migration.newKey) delete preset[migration.oldKey];
    }
}

export async function fastApplyPreset(presetIndex: number, presetName: string): Promise<void> {
    const preset = openai_settings[presetIndex] as Preset | undefined;
    if (!preset) return;

    const presetNameBefore = oai_settings.preset_settings_openai;
    oai_settings.preset_settings_openai = presetName;

    // 先迁移 legacy 字段（对齐原生 BEFORE 前的迁移步骤，openai.js:4904-4907）：
    // 就地迁移内存中的存储预设，使后续阶段写入的都是迁移后的现代字段。
    migrateLegacyPresetFields(preset);

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
            oai_settings.extensions = structuredClone(preset.extensions || {}); // 深拷贝隔离，防运行时段内改动泄漏进存储预设
            continue; // 扩展无对应 UI，直接写内存即可
        }
        if (preset[key] !== undefined) {
            // prompts / prompt_order 深拷贝隔离：防止运行时对象后续被外部改动后泄漏进存储的预设
            oai_settings[settingName] = (key === 'prompts' || key === 'prompt_order')
                ? structuredClone(preset[key])
                : preset[key];
        }
    }

    // 同步 ToolManager 工具递归上限（原生经 #tool_call_recurse_limit input 处理器设置，openai.js:6919）；
    // ?? 5 为防御性兜底（oai_settings 加载后必有该值，理论不可达）。
    ToolManager.RECURSE_LIMIT = (oai_settings.tool_call_recurse_limit ?? 5) as number;

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
