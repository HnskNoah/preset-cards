// core/storage marker：preset.extensions['preset_cards'] 特征值（关联键 + 身份）读写。
// v4 里容器不再内嵌 profiles，只留 marker + key 关联独立 preset-cards.json。零 ST 依赖。
import { buildProjectedPreset } from './project.js';

export const PRESET_CARDS_MARKER = 'preset-cards-v4';

export interface PresetCardsMarker {
    marker: 'preset-cards-v4';
    key: string;
    kind: 'preset' | 'profile';
    profileId?: string;
    profileName?: string;
    /** profile 的父节点 id（v4 树）；root 为根。 */
    parentKey?: string;
}

/** 父 preset 身份 marker。 */
export function buildPresetMarker(key: string): PresetCardsMarker {
    return { marker: PRESET_CARDS_MARKER, key, kind: 'preset' };
}

/** profile 身份 marker（注册为独立 ST preset 时写此标记）。 */
export function buildProfileMarker(key: string, profileId: string, profileName: string, parentKey: string): PresetCardsMarker {
    return { marker: PRESET_CARDS_MARKER, key, kind: 'profile', profileId, profileName, parentKey };
}

/** 给预设写入特征值（保留其他扩展字段），返回新 preset 对象。 */
export function stampPresetKey(preset: Record<string, any>, key: string): Record<string, any> {
    return buildProjectedPreset(preset, buildPresetMarker(key));
}

/** 读取预设特征值 key；无 marker 时返回 undefined。 */
export function readPresetKey(preset: Record<string, any>): string | undefined {
    const marker = preset?.extensions?.preset_cards;
    if (!marker || typeof marker !== 'object' || marker.marker !== PRESET_CARDS_MARKER) return undefined;
    return typeof marker.key === 'string' ? marker.key : undefined;
}

/** 读取完整 marker；无合法 marker 时返回 undefined。 */
export function readPresetMarker(preset: Record<string, any>): PresetCardsMarker | undefined {
    const marker = preset?.extensions?.preset_cards;
    if (!marker || typeof marker !== 'object' || marker.marker !== PRESET_CARDS_MARKER) return undefined;
    return marker as PresetCardsMarker;
}

