// core/storage project：v4 节点快照 → 独立 ST preset 对象（零 ST 依赖，纯函数）。
// profile 快照 = ST preset 实体：本体(含其他扩展) + 身份 marker。
import type { PresetSnapshot } from '../domain/types.js';
import type { PresetCardsMarker } from './marker.js';

/** 从节点快照构建可注册的 ST preset：本体快照 + extensions 其他字段 + 身份 marker。 */
export function buildProjectedPreset(snapshot: PresetSnapshot, marker: PresetCardsMarker): Record<string, any> {
    const body = structuredClone(snapshot);
    const ext = body.extensions && typeof body.extensions === 'object'
        ? structuredClone(body.extensions)
        : {};
    ext.preset_cards = structuredClone(marker);
    return { ...body, extensions: ext };
}
