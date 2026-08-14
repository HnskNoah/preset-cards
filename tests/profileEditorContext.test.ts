import { describe, it, expect } from 'vitest';
import { buildBreadcrumb, truncateBreadcrumbName } from '../src/profileEditorContext.js';
import { makeBaseProfile, makeDeltaProfile } from '../src/profileActions.js';

function makeMeta(profiles: any[]) {
    return { profiles } as any;
}

describe('truncateBreadcrumbName', () => {
    it('超长名字压缩为开头 + …', () => {
        expect(truncateBreadcrumbName('A very long ancestor name here', 12)).toBe('A very long …');
    });

    it('短名字原样返回', () => {
        expect(truncateBreadcrumbName('Short', 12)).toBe('Short');
    });

    it('空串返回空串', () => {
        expect(truncateBreadcrumbName('', 12)).toBe('');
    });
});

describe('buildBreadcrumb', () => {
    it('无父无子：只有当前项（完整）', () => {
        const root = makeBaseProfile({ id: 'a', name: 'Base A', prompts: [] });
        const meta = makeMeta([root]);
        const { items } = buildBreadcrumb(root, meta);
        expect(items).toEqual([{ name: 'Base A', isCurrent: true }]);
    });

    it('一层父：父压缩 + 当前完整', () => {
        const root = makeBaseProfile({ id: 'a', name: 'A very long ancestor name here', prompts: [] });
        const delta = makeDeltaProfile({ id: 'b', name: 'Child', baseId: 'a', changes: [] });
        const meta = makeMeta([root, delta]);
        const { items } = buildBreadcrumb(delta, meta);
        expect(items).toEqual([
            { name: 'A very long …', isCurrent: false },
            { name: 'Child', isCurrent: true },
        ]);
    });

    it('多层父：最祖先 + 折叠… + 直接父 + 当前', () => {
        const root = makeBaseProfile({ id: 'a', name: 'Root', prompts: [] });
        const mid1 = makeDeltaProfile({ id: 'b', name: 'Mid One', baseId: 'a', changes: [] });
        const mid2 = makeDeltaProfile({ id: 'c', name: 'Mid Two', baseId: 'b', changes: [] });
        const cur = makeDeltaProfile({ id: 'd', name: 'Current', baseId: 'c', changes: [] });
        const meta = makeMeta([root, mid1, mid2, cur]);
        const { items, title } = buildBreadcrumb(cur, meta);
        expect(items).toEqual([
            { name: 'Root', isCurrent: false },
            { name: '…', isCurrent: false },
            { name: 'Mid Two', isCurrent: false },
            { name: 'Current', isCurrent: true },
        ]);
        // title 保留完整链
        expect(title).toBe('Root ▸ Mid One ▸ Mid Two ▸ Current');
    });

    it('有子：子名压缩显示', () => {
        const root = makeBaseProfile({ id: 'a', name: 'Root', prompts: [] });
        const cur = makeDeltaProfile({ id: 'b', name: 'Current', baseId: 'a', changes: [] });
        const child = makeDeltaProfile({ id: 'c', name: 'A very long child name', baseId: 'b', changes: [] });
        const meta = makeMeta([root, cur, child]);
        const { items, title } = buildBreadcrumb(cur, meta);
        expect(items).toEqual([
            { name: 'Root', isCurrent: false },
            { name: 'Current', isCurrent: true },
            { name: 'A very long …', isCurrent: false },
        ]);
        expect(title).toBe('Root ▸ Current ▸ A very long child name');
    });

    it('防环：父链成环不致死循环', () => {
        const a = makeDeltaProfile({ id: 'a', name: 'A', baseId: 'b', changes: [] });
        const b = makeDeltaProfile({ id: 'b', name: 'B', baseId: 'a', changes: [] });
        const meta = makeMeta([a, b]);
        const { items } = buildBreadcrumb(a, meta);
        expect(items.length).toBeGreaterThan(0);
        expect(items.some((i) => i.isCurrent && i.name === 'A')).toBe(true);
    });
});
