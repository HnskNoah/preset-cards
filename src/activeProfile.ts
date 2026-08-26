import { oai_settings, openai_settings, openai_setting_names } from '@sillytavern/scripts/openai';
import { EXTENSION_KEY } from './constants.js';
import { getProfile, readMeta, type Preset } from './meta.js';
const STORAGE_KEY = 'preset_cards.active_profile';


export interface ActiveProfileRef {
    presetName: string;
    profileId: string;
}

let current: ActiveProfileRef | undefined;

/** 引用仍有效：父预设存在且 profile 未被删除（防原生删除/外部改动后残留悬空 ref）。 */
function activeProfileExists(ref: ActiveProfileRef): boolean {
    const idx = openai_setting_names[ref.presetName];
    if (idx === undefined) return false;
    const meta = readMeta(openai_settings[idx] as Preset);
    return getProfile(meta, ref.profileId) !== undefined;
}

export function initActiveProfile(): void {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as ActiveProfileRef;
            // 存在性校验延迟到 validateActiveProfile（SETTINGS_LOADED 后数据才完整），
            // 此处只做形状检查，避免加载早期误杀合法引用。
            if (parsed && typeof parsed.presetName === 'string' && typeof parsed.profileId === 'string') {
                current = parsed;
                return;
            }
        }
    } catch {
        // 本地存储不可解析时走迁移
    }

    // 迁移：旧版本把 activeProfileId 存在各预设的 extensions 里，此处从当前活动预设播种一次
    try {
        const activeName = oai_settings?.preset_settings_openai;
        if (typeof activeName === 'string' && activeName) {
            const idx = openai_setting_names?.[activeName];
            const preset = idx !== undefined ? openai_settings[idx] as { extensions?: Record<string, any> } : undefined;
            const legacyId = preset?.extensions?.[EXTENSION_KEY]?.activeProfileId;
            if (typeof legacyId === 'string') {
                current = { presetName: activeName, profileId: legacyId };
                localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
            }
        }
    } catch {
        current = undefined;
    }
}

/** 设置加载完成后校验持久化的活动引用；指向已删除预设/profile 时清除。init.ts 在 SETTINGS_LOADED 调用。 */
export function validateActiveProfile(): void {
    const ref = getActiveProfile();
    if (ref && !activeProfileExists(ref)) setActiveProfile(undefined);
}

export function getActiveProfile(): ActiveProfileRef | undefined {
    return current;
}

export function setActiveProfile(ref: ActiveProfileRef | undefined): void {
    current = ref;
    try {
        if (ref) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(ref));
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }
    } catch {
        // localStorage 不可用时仅内存态生效
    }
}
