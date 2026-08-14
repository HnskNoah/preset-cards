// core/storage marker：preset.extensions['preset_cards'] 特征值（关联键）读写。
// v4 里容器不再内嵌 profiles，只留 marker + key 关联独立 preset-cards.json。零 ST 依赖。

export const PRESET_CARDS_MARKER = 'preset-cards-v4';

/** 给预设写入特征值（保留其他扩展字段），返回新 preset 对象。 */
export function stampPresetKey(preset: Record<string, any>, key: string): Record<string, any> {
    const extensions = { ...(preset.extensions ?? {}) };
    extensions.preset_cards = { marker: PRESET_CARDS_MARKER, key };
    return { ...preset, extensions };
}

/** 读取预设特征值 key；无 marker 时返回 undefined。 */
export function readPresetKey(preset: Record<string, any>): string | undefined {
    const marker = preset?.extensions?.preset_cards;
    if (!marker || typeof marker !== 'object' || marker.marker !== PRESET_CARDS_MARKER) return undefined;
    return typeof marker.key === 'string' ? marker.key : undefined;
}
