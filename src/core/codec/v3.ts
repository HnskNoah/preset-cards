// core/codec v3：v4 节点 ↔ v3 兼容导出/导入形状（零 ST 依赖，纯函数）。
import type {
    PresetCardsFile,
    PresetSnapshot,
    PromptBaseProfile,
    PromptDeltaProfile,
    PromptProfileEntry,
    V4ProfileNode,
} from '../domain/types.js';
import { applyPromptDelta } from '../../promptState.js';
import { entriesFromSnapshot, entriesToSnapshot } from './snapshotEntries.js';
import { addProfileNode, createPresetCardsFile } from './v4.js';

/** 把 v4 节点导出为 v3 profiles（隐藏 root 不导出；根 profile → Base，非根 → Delta）。 */
export function toV3Profiles(file: PresetCardsFile): (PromptBaseProfile | PromptDeltaProfile)[] {
    const nodes = file.nodes.filter((n) => n.id !== 'root');
    return nodes.map((node) => {
        const parent = file.nodes.find((n) => n.id === node.parentId);
        const isRootProfile = node.parentId === undefined || node.parentId === 'root';
        if (isRootProfile) {
            return toV3Base(node);
        }
        return toV3Delta(node, parent?.id ?? '');
    });
}

function toV3Base(node: V4ProfileNode): PromptBaseProfile {
    const { entries, unusedIds } = entriesFromSnapshot(node.presetSnapshot);
    return {
        formatVersion: 3,
        kind: 'prompt_base',
        id: node.id,
        name: node.name,
        prompts: entries,
        ...(unusedIds.length > 0 ? { unusedIds } : {}),
    };
}

function toV3Delta(node: V4ProfileNode, baseId: string): PromptDeltaProfile {
    const diff = (node.diff ?? { changes: [] }) as { changes: PromptStateChangeLike[]; order?: string[] };
    return {
        formatVersion: 3,
        kind: 'prompt_delta',
        id: node.id,
        name: node.name,
        baseId,
        changes: diff.changes,
        ...(diff.order !== undefined ? { order: diff.order } : {}),
    };
}

type PromptStateChangeLike = { identifier: string; [key: string]: unknown };

/** 把单个 v3 Base 还原为 v4 文件：root 保存导入时快照，Base 成为根 profile 节点。 */
export function fromV3BaseProfile(base: PromptBaseProfile, key: string): PresetCardsFile {
    const restored = entriesToSnapshot(base.prompts);
    const file = createPresetCardsFile(restored, key);
    return addProfileNode(file, {
        id: base.id,
        name: base.name,
        presetSnapshot: restored,
    });
}

/** 把 v3 Delta 应用到父完整快照，还原为子完整快照（父链解析由调用方/导入编排负责）。 */
export function applyV3DeltaToSnapshot(parent: PresetSnapshot, delta: PromptDeltaProfile): PresetSnapshot {
    const parentEntries = entriesFromSnapshot(parent).entries;
    const childEntries: PromptProfileEntry[] = applyPromptDelta(parentEntries, delta.changes, delta.order);
    return entriesToSnapshot(childEntries);
}

/** 完整导入 v3 文件：Base + Delta 树 → v4 文件（root = 首个 Base 快照；Delta 沿父链还原全量；diff 直接带 v3 delta）。 */
export function fromV3Profiles(
    profiles: (PromptBaseProfile | PromptDeltaProfile)[],
    key: string,
): PresetCardsFile {
    const byId = new Map(profiles.map((p) => [String(p.id), p]));
    const resolved = new Map<string, PresetSnapshot>();
    const resolving = new Set<string>();

    const resolve = (profile: PromptBaseProfile | PromptDeltaProfile): PresetSnapshot => {
        const id = String(profile.id);
        const cached = resolved.get(id);
        if (cached) return cached;
        if (resolving.has(id)) return entriesToSnapshot([]); // 防环：返回空快照
        resolving.add(id);
        let snapshot: PresetSnapshot;
        if (profile.kind === 'prompt_base') {
            snapshot = entriesToSnapshot(profile.prompts);
        } else {
            const parent = byId.get(String(profile.baseId));
            const parentSnapshot = parent ? resolve(parent) : entriesToSnapshot([]);
            snapshot = applyV3DeltaToSnapshot(parentSnapshot, profile);
        }
        resolving.delete(id);
        resolved.set(id, snapshot);
        return snapshot;
    };

    // root 基线：首个 Base 快照；无 Base 时为空快照
    const firstBase = profiles.find((p): p is PromptBaseProfile => p.kind === 'prompt_base');
    const rootSnapshot = firstBase ? entriesToSnapshot(firstBase.prompts) : entriesToSnapshot([]);
    let file = createPresetCardsFile(rootSnapshot, key);

    for (const profile of profiles) {
        const id = String(profile.id);
        const snapshot = resolve(profile);
        const parentId = profile.kind === 'prompt_delta'
            ? String(profile.baseId)
            : undefined;
        file = addProfileNode(file, {
            id,
            name: profile.name,
            parentId,
            presetSnapshot: snapshot,
            ...(profile.kind === 'prompt_delta'
                ? { diff: { changes: profile.changes, ...(profile.order !== undefined ? { order: profile.order } : {}) } }
                : {}),
        });
    }
    return file;
}
