// extApply：扩展 mount/unmount/toggle 应用到预设 clone。
// 纯函数，零 ST 依赖（只操作预设对象的 extensions 字段）。

import type { ExtProfileOverride } from './core/domain/types.js';
import { EXT_ARRAY_PATHS } from './constants.js';

/** 按点号路径解析对象中的数组值。 */
function resolveArray(obj: any, path: string): any[] | undefined {
    let current = obj;
    for (const part of path.split('.')) {
        if (current == null || typeof current !== 'object') return undefined;
        current = current[part];
    }
    return Array.isArray(current) ? current : undefined;
}

/** 按点号路径设置对象中的数组值。 */
function setArray(obj: any, path: string, arr: any[]): void {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (current[parts[i]] == null) current[parts[i]] = {};
        current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = arr;
}

/** 按点号路径设置对象中的值（简单路径）。 */
function setValue(obj: any, path: string, value: any): void {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (current[parts[i]] == null) current[parts[i]] = {};
        current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
}

/**
 * 应用单条 toggle：支持两种路径格式——
 * - 简单路径："SPreset.ChatSquash.enabled" → 直接遍历设置
 * - 数组条目路径："regex_scripts.{id}.disabled" → 按 id 查找数组条目再设字段
 */
function applyToggle(ext: Record<string, any>, path: string, value: boolean): void {
    for (const arrayPath of EXT_ARRAY_PATHS) {
        const prefix = arrayPath + '.';
        if (path.startsWith(prefix)) {
            const rest = path.slice(prefix.length);
            const dotIdx = rest.indexOf('.');
            if (dotIdx > 0) {
                const itemId = rest.slice(0, dotIdx);
                const field = rest.slice(dotIdx + 1);
                const arr = resolveArray(ext, arrayPath);
                if (arr) {
                    const item = arr.find((x: any) => x.id === itemId);
                    if (item) item[field] = value;
                }
                return;
            }
        }
    }
    setValue(ext, path, value);
}

/**
 * 应用扩展覆盖到预设 clone：
 * 1. unmount：从数组中按 id 移除条目
 * 2. mount：向数组中按 id 新增条目（不重复）
 * 3. toggle：设置布尔值（支持简单路径和数组条目路径）
 */
export function applyExtensions(
    preset: Record<string, any>,
    extProfile: ExtProfileOverride | undefined,
): void {
    if (!extProfile) return;
    const ext = preset.extensions as Record<string, any> | undefined;
    if (!ext) return;

    // Unmounts：从数组中移除条目
    if (extProfile.extUnmounts) {
        for (const [path, ids] of Object.entries(extProfile.extUnmounts)) {
            const arr = resolveArray(ext, path);
            if (!arr) continue;
            const idSet = new Set(ids);
            const filtered = arr.filter((item: any) => !idSet.has(item.id));
            if (filtered.length !== arr.length) {
                setArray(ext, path, filtered);
            }
        }
    }

    // Mounts：向数组中新增条目（不重复）
    if (extProfile.extMounts) {
        for (const [path, entries] of Object.entries(extProfile.extMounts)) {
            const arr = resolveArray(ext, path) ?? [];
            const existingIds = new Set(arr.map((item: any) => item.id).filter(Boolean));
            for (const entry of entries) {
                if (!existingIds.has(entry.id)) {
                    arr.push(structuredClone(entry.definition));
                    existingIds.add(entry.id);
                }
            }
            setArray(ext, path, arr);
        }
    }

    // Toggles：设置布尔值
    if (extProfile.extToggles) {
        for (const [path, value] of Object.entries(extProfile.extToggles)) {
            applyToggle(ext, path, value);
        }
    }
}