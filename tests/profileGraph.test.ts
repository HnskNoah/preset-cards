import { describe, it, expect } from 'vitest';
import { buildBreadcrumb, buildForest, collectAncestors, collectDescendants } from '../src/core/profile/graph.js';
import type { V4ProfileNode } from '../src/core/domain/types.js';

function node(id: string, parentId?: string): V4ProfileNode {
    return {
        id,
        name: id,
        parentId,
        presetSnapshot: { prompts: [], prompt_order: [] },
    };
}

const nodes: V4ProfileNode[] = [
    node('root'),
    node('A', 'root'),
    node('B', 'A'),
    node('C', 'A'),
    node('D', 'B'),
];

describe('core profile graph', () => {
    it('builds a forest from parentId links, ignoring hidden root', () => {
        const forest = buildForest(nodes);
        expect(forest.map((n) => n.node.id)).toEqual(['A']);
        expect(forest[0].children.map((n) => n.node.id)).toEqual(['B', 'C']);
        expect(forest[0].children[0].children.map((n) => n.node.id)).toEqual(['D']);
    });

    it('collects ancestors from node to root (excluding self)', () => {
        expect(collectAncestors(nodes, 'D').map((n) => n.id)).toEqual(['A', 'B']);
    });

    it('collects all descendants (cascade set)', () => {
        expect(collectDescendants(nodes, 'A').map((n) => n.id)).toEqual(['B', 'C', 'D']);
    });

    it('builds a breadcrumb chain from root ancestor to current node, truncating long names', () => {
        const longNameNodes: V4ProfileNode[] = [
            node('root'),
            { ...node('A', 'root'), name: 'this-is-a-very-long-profile-name' },
            { ...node('B', 'A'), name: 'B' },
        ];

        const breadcrumb = buildBreadcrumb(longNameNodes, 'B');

        expect(breadcrumb.map((b) => b.id)).toEqual(['A', 'B']);
        expect(breadcrumb[0].name).toBe('this-is-a-ve…');
        expect(breadcrumb[0].truncated).toBe(true);
        expect(breadcrumb[1].truncated).toBe(false);
    });
});
