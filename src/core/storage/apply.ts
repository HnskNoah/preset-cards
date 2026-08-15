// core/storage apply：把 v4 快照应用到目标 preset（零 ST 依赖，纯函数）。
import type { PresetSnapshot } from '../domain/types.js';

/** 用快照覆盖 preset 本体 + 其他扩展；保留目标 preset 当前的 preset_cards 特征值。返回新 preset。 */
export function applySnapshotToPreset(preset: Record<string, any>, snapshot: PresetSnapshot): Record<string, any> {
    const body = structuredClone(snapshot);
    const currentMarker = preset?.extensions?.preset_cards;
    const snapshotExt = body.extensions && typeof body.extensions === 'object'
        ? structuredClone(body.extensions)
        : {};
    if (currentMarker !== undefined) snapshotExt.preset_cards = structuredClone(currentMarker);
    return { ...body, extensions: snapshotExt };
}
