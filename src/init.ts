import { t } from '@sillytavern/scripts/i18n';
import { SlashCommand } from '@sillytavern/scripts/slash-commands/SlashCommand';
import { SlashCommandParser } from '@sillytavern/scripts/slash-commands/SlashCommandParser';
import { openPresetCards } from './presetCards.js';
import { getActiveProfile, initActiveProfile, validateActiveProfile } from './activeProfile.js';
import { eventSource, event_types } from '@sillytavern/scripts/events';
import { applyProfileToPresetByName, getPresetProfiles, getProfileModel, listPresetsWithProfiles, notifyProfileChanged, onProfileChanged } from './presetCardsState.js';
import { initPresetOrderNormalization } from './fastApply.js';
import { flushPendingSaves } from './meta.js';
import { initPresetRegistration, initRegisteredPresetActivation, initRegisteredPresetObserver, onActiveProfileChangedBySwitch, syncAllPresetRegistrations } from './presetRegistration.js';
import { initPresetCapture } from './presetCapture.js';
import type { PresetCardsApi } from './types/presetCardsApi.js';

let _initialized = false;

export function refresh(): void {
    location.reload();
}

/** 外部扩展集成入口（挂 window.presetCards）：供 ST-Quicker-Api 等便捷方案加载/查询 profile。 */
export function exposePresetCardsApi(): PresetCardsApi {
    return {
        loadProfile: applyProfileToPresetByName,
        getProfiles: getPresetProfiles,
        getProfileModel,
        listPresets: listPresetsWithProfiles,
        getActiveProfile: () => getActiveProfile(),
        onProfileChanged,
    };
}

export function init(): void {
    if (_initialized) return;
    _initialized = true;
    initActiveProfile();
    initPresetOrderNormalization();
    initPresetRegistration();
    // 启动/reload 全量对账（幂等）：服务端按预设文件重建数组,已有 profile 需重新注册为投影
    try {
        syncAllPresetRegistrations();
    } catch (err) {
        console.error('preset-cards: startup registration sync failed', err);
    }
    initRegisteredPresetActivation();
    initRegisteredPresetObserver();
    initPresetCapture();
    // 设置加载完成后校验持久化的 activeProfile 引用（指向已删除预设/profile 时清除）
    eventSource.on(event_types.SETTINGS_LOADED, () => {
        try {
            validateActiveProfile();
        } catch (err) {
            console.error('preset-cards: active profile validation failed', err);
        }
    });
    // 原生切换激活 profile 时,与所有加载路径(卡片行/concise/API)统一通知外部扩展
    onActiveProfileChangedBySwitch((ref) => {
        if (ref) notifyProfileChanged(ref);
    });

    // 对外入口：供其它扩展（如 ST-Quicker-Api 便捷方案）加载 preset-cards 的 profile
    window.presetCards = exposePresetCardsApi();

    // 关页/刷新前尽力落盘合并窗口内挂起的保存（best-effort：异步 fetch 在卸载时不保证完成）
    window.addEventListener('pagehide', flushPendingSaves);

    mountWandButton();

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'presetcards',
        callback: async () => {
            await openPresetCards();
            return '';
        },
        helpString: 'Opens the preset cards view for Chat Completion presets.',
    }));
}

/** 侧边栏 wand 按钮：容器可能尚未渲染（ShareTarven 早期注入时早于 DOM ready），
 * DOM ready 后重试一次；仍缺失则告警放弃（斜杠命令 / 事件监听不受影响）。 */
function mountWandButton(): void {
    const container = $('#token_counter_wand_container');
    if (container.length === 0) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => mountWandButton(), { once: true });
            return;
        }
        console.warn('preset-cards: #token_counter_wand_container not found, wand button not mounted');
        return;
    }
    const buttonHtml = `
        <div id="preset_cards_button" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-grip extensionsMenuExtensionButton"></div>` +
        t`Preset Cards` +
        '</div>';
    container.append(buttonHtml);
    $('#preset_cards_button').on('click', openPresetCards);
}

// 自初始化：兼容 ShareTarven 非生命周期模式（extensionLifecycle: false），
// 该模式加载脚本后不调用 manifest hooks，init() 不会自动执行。
// 生命周期模式下由 extensionLifecycle.activate 调用 init()，守卫防重复执行；
// window 哨兵防同一页面重复加载脚本（注入器缓存异常时模块作用域独立，模块级守卫失效，
// 双重 init 会重复注册事件监听与斜杠命令、重复追加按钮）。
if (!(window as any).__presetCards_initialized) {
    (window as any).__presetCards_initialized = true;
    init();
}
