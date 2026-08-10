// profile 派生关系树：把平铺的 base/delta 数组组织成森林并按树序展平。
// 纯函数，不接触 DOM/持久化；供 presetList 组装卡片行使用。
// 对齐 importExport 的 childrenByParent + DFS 模式，额外用 visited 防环（损坏/导入成环不死循环）。

import { isPromptBaseProfile, isPromptDeltaProfile, type PresetProfile } from './meta.js';

export interface ProfileTreeNode {
    profile: PresetProfile;
    children: ProfileTreeNode[];
}

/** 树序展平后的展示行。 */
export interface FlattenedProfileRow {
    profile: PresetProfile;
    depth: number;
}

/**
 * 把平铺的 profiles 组织成派生关系森林。
 * 根 = base/v1 节点 + baseId 无对应 base/delta 父的孤立 delta；同层保持原数组相对顺序。
 */
export function buildProfileForest(profiles: PresetProfile[]): ProfileTreeNode[] {
    const childrenByParent = new Map<string, ProfileTreeNode[]>();
    const nodeById = new Map<string, ProfileTreeNode>();

    for (const p of profiles) {
        nodeById.set(String(p.id), { profile: p, children: [] });
    }

    for (const p of profiles) {
        if (isPromptDeltaProfile(p)) {
            const parent = nodeById.get(String(p.baseId));
            if (parent && (isPromptBaseProfile(parent.profile) || isPromptDeltaProfile(parent.profile))) {
                const list = childrenByParent.get(String(p.baseId)) ?? [];
                list.push(nodeById.get(String(p.id)) as ProfileTreeNode);
                childrenByParent.set(String(p.baseId), list);
                parent.children = list;
            }
        }
    }

    const roots: ProfileTreeNode[] = [];
    for (const p of profiles) {
        if (isPromptBaseProfile(p) || !isPromptDeltaProfile(p)) {
            roots.push(nodeById.get(String(p.id)) as ProfileTreeNode);
        }
    }
    // 未被任何根可达的 delta（孤立：baseId 无对应 base/delta 父；或成环：互相引用但无根祖先）
    // 作为根节点收尾（对齐 importExport：先 root 树、再收尾未访问节点），保证每个 profile 都展示且不丢。
    const reached = new Set<string>();
    const mark = (node: ProfileTreeNode): void => {
        if (reached.has(String(node.profile.id))) return;
        reached.add(String(node.profile.id));
        for (const child of node.children) mark(child);
    };
    for (const root of roots) mark(root);
    for (const p of profiles) {
        if (!reached.has(String(p.id))) {
            roots.push(nodeById.get(String(p.id)) as ProfileTreeNode);
            reached.add(String(p.id));
        }
    }
    return roots;
}

/**
 * DFS 根先序展平森林为展示行（父在子前），同层保持原数组相对顺序；visited 防环。
 */
export function flattenProfileForest(forest: ProfileTreeNode[]): FlattenedProfileRow[] {
    const result: FlattenedProfileRow[] = [];
    const visited = new Set<string>();
    const stack: { node: ProfileTreeNode; depth: number }[] = [];
    for (let i = forest.length - 1; i >= 0; i--) {
        stack.push({ node: forest[i], depth: 0 });
    }
    while (stack.length > 0) {
        const { node, depth } = stack.pop() as { node: ProfileTreeNode; depth: number };
        if (visited.has(String(node.profile.id))) continue;
        visited.add(String(node.profile.id));
        result.push({ profile: node.profile, depth });
        const children = node.children;
        for (let i = children.length - 1; i >= 0; i--) {
            const child = children[i];
            if (!visited.has(String(child.profile.id))) {
                stack.push({ node: child, depth: depth + 1 });
            }
        }
    }
    return result;
}
