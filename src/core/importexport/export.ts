// core/importexport export：v4 文件 → v3 兼容导出对象（零 ST 依赖，纯函数）。
import { toV3Profiles } from '../codec/v3.js';
import type { PresetCardsFile } from '../domain/types.js';

export interface V3Export {
    name?: string;
    prompts?: any[];
    prompt_order?: any[];
    extensions: {
        preset_cards: { profiles: ReturnType<typeof toV3Profiles> };
    };
    [key: string]: unknown;
}

/** 组装 v3 兼容导出：root 快照作预设本体（深拷贝），profiles 用 toV3Profiles。 */
export function buildV3Export(file: PresetCardsFile): V3Export {
    const root = file.nodes.find((n) => n.id === 'root');
    const body = structuredClone(root?.presetSnapshot ?? {});
    return {
        ...body,
        extensions: {
            ...(body.extensions ?? {}),
            preset_cards: { profiles: toV3Profiles(file) },
        },
    };
}
