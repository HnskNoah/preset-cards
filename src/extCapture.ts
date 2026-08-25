// extCapture：扩展 mount/unmount/toggle 漂移检测。
// 纯函数：比较运行时 extensions vs 传入基线 extensions。注册捕获传「继承基线」
// （父预设 ⊕ 祖先层 extProfile，见 extApply.buildInheritedExtensionBaseline）——应用沿链重放，
// 捕获必须同基线对齐：否则祖先挂载条目的编辑会记成后代重复 mount 且永不重放、删除则不可捕获。
import type { ExtProfileOverride, ExtMountEntry } from './core/domain/types.js';
import { EXT_ARRAY_PATHS, EXT_BOOLEAN_PATHS } from './constants.js';
import { stableStringify } from './stableStringify.js';

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

/** 两对象除 disabled/enabled 外是否完全一致（键级稳定序列化比较）。 */
function differsOnlyByToggle(a: any, b: any): boolean {
    if (stableStringify(a) === stableStringify(b)) return false;
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    for (const key of keys) {
        if (key === 'disabled' || key === 'enabled') continue;
        if (stableStringify((a ?? {})[key]) !== stableStringify((b ?? {})[key])) return false;
    }
    return true;
}

/**
 * 计算扩展漂移：运行时 vs 传入基线（注册捕获 = 继承基线，见 buildInheritedExtensionBaseline）。
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

    // Array paths：mount（新增 + 共有条目定义被改写→整条覆盖重捕获）/ unmount / 仅开关变化→toggle。
    // 共有条目归一比较开关缺省语义（disabled 缺省 false、enabled 缺省 true），
    // 否则「runtime 显式 false vs 基线未写入」的等价状态会产生永真 toggle，净零永远不成立。
    for (const path of EXT_ARRAY_PATHS) {
        const runtimeArr = resolveArray(runtimeExt, path) ?? [];
        const parentArr = resolveArray(parentExt, path) ?? [];

        const runtimeById = new Map<string, any>(
            runtimeArr.filter((item: any) => item.id).map((item: any) => [item.id, item]),
        );
        const parentById = new Map<string, any>(
            parentArr.filter((item: any) => item.id).map((item: any) => [item.id, item]),
        );

        const mounted: ExtMountEntry[] = [];
        const overridden = new Set<string>();
        for (const [id, item] of runtimeById) {
            const parentItem = parentById.get(id);
            if (!parentItem) {
                mounted.push({ id, definition: structuredClone(item) });
                continue;
            }
            if (stableStringify(item) !== stableStringify(parentItem) && !differsOnlyByToggle(item, parentItem)) {
                // 定义内容被改写：整条覆盖（跨层后写者胜），开关字段随定义一并生效
                mounted.push({ id, definition: structuredClone(item) });
                overridden.add(id);
            }
        }
        if (mounted.length > 0) mount[path] = mounted;

        const unmounted: string[] = [];
        for (const id of parentById.keys()) {
            if (!runtimeById.has(id)) {
                unmounted.push(id);
            }
        }
        if (unmounted.length > 0) unmount[path] = unmounted;

        for (const [id, runtimeItem] of runtimeById) {
            if (overridden.has(id)) continue; // 已整条覆盖,不再重复记 toggle
            const parentItem = parentById.get(id);
            if (!parentItem) continue;
            if ((runtimeItem.disabled ?? false) !== (parentItem.disabled ?? false)) {
                toggles[`${path}.${id}.disabled`] = runtimeItem.disabled;
            }
            if ((runtimeItem.enabled ?? true) !== (parentItem.enabled ?? true)) {
                toggles[`${path}.${id}.enabled`] = runtimeItem.enabled;
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