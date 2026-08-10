import { getRequestHeaders } from '@sillytavern/script';
import { t } from '@sillytavern/scripts/i18n';
import { openai_settings, oai_settings } from '@sillytavern/scripts/openai';
import { EXTENSION_KEY } from './constants.js';

/** 预设对象的最小结构;其余字段是 ST 的任意设置,保持宽松。 */
export type Preset = Record<string, any> & {
    extensions?: Record<string, any>;
};

export interface PresetProfileV1 {
    id: string;
    name: string;
    settings: Record<string, any>;
    formatVersion?: 1;
}

/** prompt 值字段（全可选，向后兼容旧数据）。 */
export interface PromptFields {
    content?: string;
    name?: string;
    role?: string;
    injection_position?: number;
    injection_depth?: number;
    injection_order?: number;
}

/** 主 profile：记录当前目标 prompt_order.order 中 prompts 的开关，可附带值字段（fields），不存扩展。 */
export interface PromptBaseProfile {
    formatVersion: 2;
    kind: 'prompt_base';
    id: string;
    name: string;
    prompts: { identifier: string; enabled: boolean; fields?: PromptFields }[];
}

/** 派生 profile 的一条差异：开关差异 + 值差异（content/role/name 等）。 */
export interface PromptDeltaChange {
    identifier: string;
    enabled?: boolean;
    fields?: Record<string, any>;
}

/** 派生 profile：相对主 profile 的差异，加载时「主 + 子」叠加应用。 */
export interface PromptDeltaProfile {
    formatVersion: 2;
    kind: 'prompt_delta';
    id: string;
    name: string;
    baseId: string;
    changes: PromptDeltaChange[];
}

/** defaultSnapshot 条目：开关 + 惰性记录首次编辑前的原始值字段（reset 还原用，可选）。 */
export interface PromptDefaultSnapshotEntry {
    identifier: string;
    enabled: boolean;
    originalFields?: PromptFields;
}

export type PresetProfile = PresetProfileV1 | PromptBaseProfile | PromptDeltaProfile;

export function isPromptBaseProfile(profile: PresetProfile): profile is PromptBaseProfile {
    return (profile as { kind?: string }).kind === 'prompt_base';
}

export function isPromptDeltaProfile(profile: PresetProfile): profile is PromptDeltaProfile {
    return (profile as { kind?: string }).kind === 'prompt_delta';
}

export interface PresetMeta {
    description: string;
    models: string[];
    profiles: PresetProfile[];
    bgImage: string;
    /** 隐藏默认基准：自动维护，不显示、不参与派生。供重置回退。 */
    defaultSnapshot?: PromptDefaultSnapshotEntry[];
    /** 默认基准是否已全量锁定（区分旧版仅开关快照与新版含 originalFields 的全量基线）。 */
    defaultSnapshotLocked?: boolean;
}

/** 按 id 查 profile（id 归一化为字符串，兼容数字/字符串来源）。 */
export function getProfile(meta: PresetMeta, profileId: unknown): PresetProfile | undefined {
    return meta.profiles.find((p) => p.id === String(profileId));
}

/** 生成新的 profile id（时间戳 + 随机后缀）。 */
export function newProfileId(): string {
    return Date.now().toString() + Math.floor(Math.random() * 1000);
}

/**
 * Read the preset_cards metadata from a preset object.
 */
export function readMeta(preset: Preset | undefined): PresetMeta {
    const ext = preset?.extensions?.[EXTENSION_KEY];
    return {
        description: ext?.description || '',
        models: Array.isArray(ext?.models) ? ext.models : [],
        profiles: Array.isArray(ext?.profiles) ? ext.profiles : [],
        bgImage: ext?.bgImage || '',
        defaultSnapshot: Array.isArray(ext?.defaultSnapshot) ? ext.defaultSnapshot : undefined,
        defaultSnapshotLocked: ext?.defaultSnapshotLocked === true,
    };
}

/**
 * Persist metadata into the preset's extensions field and save to disk.
 */
export async function saveMeta(presetName: string, presetIndex: number, meta: PresetMeta): Promise<void> {
    const preset = openai_settings[presetIndex] as Preset | undefined;
    if (!preset) return;

    // Ensure extensions object exists
    if (!preset.extensions) preset.extensions = {};
    preset.extensions[EXTENSION_KEY] = {
        description: meta.description || '',
        models: meta.models || [],
        profiles: meta.profiles || [],
        bgImage: meta.bgImage || '',
        defaultSnapshot: meta.defaultSnapshot,
        defaultSnapshotLocked: meta.defaultSnapshotLocked === true,
    };

    // Also update oai_settings if this is the current preset
    if (oai_settings.preset_settings_openai === presetName) {
        if (!oai_settings.extensions) oai_settings.extensions = {};
        oai_settings.extensions[EXTENSION_KEY] = preset.extensions[EXTENSION_KEY];
    }

    // Build the preset body from the actual preset object (not from oai_settings,
    // which reflects the *currently active* preset — possibly a different one).
    const presetBody = structuredClone(preset);

    const response = await fetch('/api/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            apiId: 'openai',
            name: presetName,
            preset: presetBody,
        }),
    });

    if (!response.ok) {
        toastr.error(t`Failed to save preset metadata`);
        console.error('Failed to save preset metadata', response);
        throw new Error('Failed to save preset metadata');
    }
}
