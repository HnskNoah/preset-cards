// core/profile graph：v4 节点树的纯函数操作（零 ST 依赖）。
import type { V4ProfileNode } from '../domain/types.js';

/** 树节点：节点 + 直接子节点。 */
export interface ProfileTreeNode {
    node: V4ProfileNode;
    children: ProfileTreeNode[];
}

/** 构建派生森林：隐藏 root 不出现；parentId 指向 root/无父的节点是树根。 */
export function buildForest(nodes: V4ProfileNode[]): ProfileTreeNode[] {
    const byId = new Map(nodes.map((n) => [String(n.id), n]));
    const childrenOf = new Map<string, V4ProfileNode[]>();
    for (const n of nodes) {
        const parentId = n.parentId !== undefined && n.parentId !== 'root' ? String(n.parentId) : undefined;
        if (parentId !== undefined && byId.has(parentId)) {
            const list = childrenOf.get(parentId) ?? [];
            list.push(n);
            childrenOf.set(parentId, list);
        }
    }
    const build = (id: string): ProfileTreeNode => {
        const node = byId.get(id)!;
        return {
            node,
            children: (childrenOf.get(id) ?? []).map((c) => build(String(c.id))),
        };
    };
    return nodes
        .filter((n) => n.id !== 'root' && (n.parentId === undefined || n.parentId === 'root' || !byId.has(String(n.parentId))))
        .map((n) => build(String(n.id)));
}

/** 收集祖先链（根 → 近父，不含 self；root 隐藏节点不返回）。 */
export function collectAncestors(nodes: V4ProfileNode[], nodeId: string): V4ProfileNode[] {
    const byId = new Map(nodes.map((n) => [String(n.id), n]));
    const result: V4ProfileNode[] = [];
    const seen = new Set<string>();
    let current = byId.get(String(nodeId));
    while (current && current.parentId !== undefined && current.parentId !== 'root' && !seen.has(String(current.id))) {
        seen.add(String(current.id));
        const parent = byId.get(String(current.parentId));
        if (!parent) break;
        result.push(parent);
        current = parent;
    }
    return result.reverse();
}

/** 收集全部后代（含多层派生；不含 self，防环）。 */
export function collectDescendants(nodes: V4ProfileNode[], nodeId: string): V4ProfileNode[] {
    const byParent = new Map<string, V4ProfileNode[]>();
    for (const n of nodes) {
        if (n.parentId === undefined) continue;
        const list = byParent.get(String(n.parentId)) ?? [];
        list.push(n);
        byParent.set(String(n.parentId), list);
    }
    const result: V4ProfileNode[] = [];
    const seen = new Set<string>([String(nodeId)]);
    const queue = [String(nodeId)];
    while (queue.length > 0) {
        const current = queue.shift()!;
        for (const child of byParent.get(current) ?? []) {
            const id = String(child.id);
            if (seen.has(id)) continue;
            seen.add(id);
            result.push(child);
            queue.push(id);
        }
    }
    return result;
}
