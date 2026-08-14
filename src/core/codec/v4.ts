// core/codec v4：preset-cards.json 文件格式（零 ST 依赖，纯函数）。
import type { PresetCardsFile, PresetSnapshot, V4ProfileNode } from '../domain/types.js';
import { diffSnapshot } from '../diff/snapshot.js';

export const PRESET_CARDS_MARKER = 'preset-cards-v4';

/** root 节点固定 id：导入时原始快照的隐藏基线。 */
export const ROOT_NODE_ID = 'root';

/** 从完整 preset 生成 v4 文件对象：root 保存导入时快照（剔除 preset_cards 容器），presets 记录归属。 */
export function createPresetCardsFile(preset: PresetSnapshot, key: string): PresetCardsFile {
    const root: V4ProfileNode = {
        id: ROOT_NODE_ID,
        name: 'root',
        presetSnapshot: stripPresetCardsContainer(preset),
    };
    return {
        version: 4,
        presets: [{ key, profileIds: [] }],
        nodes: [root],
    };
}

/** 快照不应包含插件自己的 preset_cards 容器（避免自引用/递归膨胀）。 */
export function stripPresetCardsContainer(preset: PresetSnapshot): PresetSnapshot {
    const clone = structuredClone(preset);
    if (clone.extensions && typeof clone.extensions === 'object') {
        const ext = { ...clone.extensions };
        delete ext.preset_cards;
        clone.extensions = ext;
    }
    return clone;
}

/** 在 v4 文件中删除节点并级联删除全部后继（parentId 指向它的节点及其子树）。 */
export function deleteNode(file: PresetCardsFile, nodeId: string): PresetCardsFile {
    const deleted = new Set<string>([nodeId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const n of file.nodes) {
            if (n.parentId !== undefined && deleted.has(n.parentId) && !deleted.has(n.id)) {
                deleted.add(n.id);
                changed = true;
            }
        }
    }
    return {
        ...file,
        presets: file.presets.map((p) => ({
            ...p,
            profileIds: p.profileIds.filter((id) => !deleted.has(id)),
        })),
        nodes: file.nodes.filter((n) => !deleted.has(n.id)),
    };
}

/** 在 v4 文件中更新节点快照：替换 presetSnapshot，并相对父节点（root 或 parentId）重算 diff。 */
export function updateProfileNode(
    file: PresetCardsFile,
    nodeId: string,
    newSnapshot: PresetSnapshot,
): PresetCardsFile {
    const snapshot = stripPresetCardsContainer(newSnapshot);
    return {
        ...file,
        nodes: file.nodes.map((n) => {
            if (String(n.id) !== String(nodeId)) return n;
            const parent = n.parentId !== undefined
                ? file.nodes.find((p) => String(p.id) === String(n.parentId))
                : undefined;
            const parentSnapshot = parent ? parent.presetSnapshot : undefined;
            const diff = parentSnapshot ? diffSnapshot(parentSnapshot, snapshot) : undefined;
            return {
                ...n,
                presetSnapshot: snapshot,
                ...(diff !== undefined ? { diff } : {}),
            };
        }),
    };
}

/** 在 v4 文件中新增一个 profile 节点（默认挂到 root，全量快照 + 相对 root 的 diff 由调用方/Phase 2 计算）。 */
export function addProfileNode(
    file: PresetCardsFile,
    node: { id: string; name: string; presetSnapshot: PresetSnapshot; parentId?: string; diff?: unknown },
): PresetCardsFile {
    return {
        ...file,
        presets: file.presets.map((p, i) => (i === 0 ? { ...p, profileIds: [...p.profileIds, node.id] } : p)),
        nodes: [
            ...file.nodes,
            {
                id: node.id,
                name: node.name,
                parentId: node.parentId ?? ROOT_NODE_ID,
                presetSnapshot: stripPresetCardsContainer(node.presetSnapshot),
                ...(node.diff !== undefined ? { diff: node.diff } : {}),
            },
        ],
    };
}

