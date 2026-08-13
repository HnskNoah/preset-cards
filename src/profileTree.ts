// profile 派生关系树：把平铺的 base/delta 数组组织成森林并按树序展平。
// 纯函数，不接触 DOM/持久化；供 presetList 组装卡片行使用。
// 对齐 importExport 的 childrenByParent + DFS 模式，额外用 visited 防环（损坏/导入成环不死循环）。

import { isPromptBaseProfile, isPromptDeltaProfile, type PresetProfile } from './meta.js';

export interface ProfileTreeNode {
    profile: PresetProfile;
    children: ProfileTreeNode[];
}

/**
 * 把平铺的 profiles 组织成派生关系森林。
 * 根 = base 节点 + baseId 无对应 base/delta 父的孤立 delta；同层保持原数组相对顺序。
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

    // 根候选 = base 节点 + baseId 无对应 base/delta 父的孤立 delta。
    // 按原数组顺序收集（同层保持原数组相对顺序）；成环簇（互相引用但无根祖先）随后收尾。
    const roots: ProfileTreeNode[] = [];
    for (const p of profiles) {
        if (!nodeById.has(String(p.id))) continue;
        if (isPromptBaseProfile(p) || !isPromptDeltaProfile(p)) {
            roots.push(nodeById.get(String(p.id)) as ProfileTreeNode);
            continue;
        }
        const parent = nodeById.get(String(p.baseId));
        if (!parent || (!isPromptBaseProfile(parent.profile) && !isPromptDeltaProfile(parent.profile))) {
            roots.push(nodeById.get(String(p.id)) as ProfileTreeNode);
        }
    }
    const reached = new Set<string>();
    const mark = (node: ProfileTreeNode): void => {
        if (reached.has(String(node.profile.id))) return;
        reached.add(String(node.profile.id));
        for (const child of node.children) mark(child);
    };
    for (const root of roots) mark(root);
    for (const p of profiles) {
        if (!nodeById.has(String(p.id))) continue;
        if (!reached.has(String(p.id))) {
            roots.push(nodeById.get(String(p.id)) as ProfileTreeNode);
            reached.add(String(p.id));
        }
    }
    return roots;
}

/**
 * 把森林构造成嵌套树（供卡片分组折叠渲染）：每个节点携带自身 profile、相对根的 depth，
 * children 为其直接 delta 后代（递归）。visited 防环（成环/自环节点整枝跳过，不重复渲染）。
 */
export interface NestedProfileNode {
    profile: PresetProfile;
    depth: number;
    children: NestedProfileNode[];
}

export function buildProfileNested(forest: ProfileTreeNode[]): NestedProfileNode[] {
    const build = (node: ProfileTreeNode, depth: number, visited: Set<string>): NestedProfileNode | null => {
        const id = String(node.profile.id);
        if (visited.has(id)) return null;
        visited.add(id);
        const children: NestedProfileNode[] = [];
        for (const child of node.children) {
            const built = build(child, depth + 1, visited);
            if (built) children.push(built);
        }
        return { profile: node.profile, depth, children };
    };
    const visited = new Set<string>();
    const roots: NestedProfileNode[] = [];
    for (const root of forest) {
        const built = build(root, 0, visited);
        if (built) roots.push(built);
    }
    return roots;
}
