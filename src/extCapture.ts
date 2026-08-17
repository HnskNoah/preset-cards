// extCapture：扩展 mount/unmount/toggle 漂移检测。
// 纯函数：比较运行时 extensions vs 父预设 extensions，产出差异。

import type { ExtProfileOverride, ExtMountEntry } from './core/domain/types.js';
import { EXT_ARRAY_PATHS, EXT_BOOLEAN_PATHS } from './constants.js';

/** 按点号路径解析对象中的值。 */
function resolveValue(obj: any, path: string): any {
    let current = obj;
    for (const part of path.split('.')) {
        if (current == null || typeof current !== 'object') return undefined;
        current = current[part];
    }
    return current;
}

/** 按点号路径解析对象中的数组值。 */
function resolveArray(obj: any, path: string): any[] | undefined {
    let current = obj;
    for (const part of path.split('.')) {
        if (current == null || typeof current !== 'object') return undefined;
        current = current[part];
    }
    return Array.isArray(current) ? current : undefined;
}

/**
 * 计算扩展漂移：运行时 vs 父预设。
 * 每次捕获都全量重新计算，不是增量——确保 profile 始终反映当前差异。
 * 无差异返回 null。
 */
export function computeExtensionDrift(
    runtime: Record<string, any>,
    parent: Record<string, any>,
): ExtProfileOverride | null {
    const runtimeExt = (runtime.extensions as Record<string, any>) ?? {};
    const parentExt = (parent.extensions as Record<string, any>) ?? {};

    const mount: Record<string, ExtMountEntry[]> = {};
    const unmount: Record<string, string[]> = {};
    const toggles: Record<string, boolean> = {};

    // Array paths：检测 mount/unmount + 共享条目的 disabled toggle
    for (const path of EXT_ARRAY_PATHS) {
        const runtimeArr = resolveArray(runtimeExt, path) ?? [];
        const parentArr = resolveArray(parentExt, path) ?? [];

        const runtimeById = new Map<string, any>(
            runtimeArr.filter((item: any) => item.id).map((item: any) => [item.id, item]),
        );
        const parentById = new Map<string, any>(
            parentArr.filter((item: any) => item.id).map((item: any) => [item.id, item]),
        );

        // Mount：运行时独有（不在父预设中）
        const mounted: ExtMountEntry[] = [];
        for (const [id, item] of runtimeById) {
            if (!parentById.has(id)) {
                mounted.push({ id, definition: structuredClone(item) });
            }
        }
        if (mounted.length > 0) mount[path] = mounted;

        // Unmount：父预设有但运行时没有
        const unmounted: string[] = [];
        for (const id of parentById.keys()) {
            if (!runtimeById.has(id)) {
                unmounted.push(id);
            }
        }
        if (unmounted.length > 0) unmount[path] = unmounted;

        // Toggle：两者共有条目上的 disabled 字段变化
        for (const [id, runtimeItem] of runtimeById) {
            const parentItem = parentById.get(id);
            if (!parentItem) continue;
            if (runtimeItem.disabled !== parentItem.disabled) {
                toggles[`${path}.${id}.disabled`] = runtimeItem.disabled;
            }
        }
    }

    // Boolean paths：检测简单布尔值变化
    for (const path of EXT_BOOLEAN_PATHS) {
        const runtimeVal = resolveValue(runtimeExt, path);
        const parentVal = resolveValue(parentExt, path);
        if (typeof runtimeVal === 'boolean' && runtimeVal !== parentVal) {
            toggles[path] = runtimeVal;
        }
    }

    // 只输出非空部分
    const out: ExtProfileOverride = {};
    if (Object.keys(mount).length > 0) out.extMounts = mount;
    if (Object.keys(unmount).length > 0) out.extUnmounts = unmount;
    if (Object.keys(toggles).length > 0) out.extToggles = toggles;

    return Object.keys(out).length > 0 ? out : null;
}