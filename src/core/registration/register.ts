// core/registration：profile → ST preset 注册/反查/清理（零 ST 依赖，纯函数）。
// 注册表用 PresetRegistry 抽象（ST 适配层实现为 openai_settings + openai_setting_names）；
// 命名策略 PresetNaming 可注入——注册名格式与去重规则待定，不阻塞注册流程。

import type { PresetSnapshot } from '../domain/types.js';
import { buildProfileMarker, readPresetMarker } from '../storage/marker.js';
import { buildProjectedPreset } from '../storage/project.js';

/** 注册名生成策略（命名规则待定；反查走 marker，与名字无关）。 */
export interface PresetNaming {
    /** 生成唯一注册名：输入父预设名 / profile 名 / ST 当前全部预设名（策略自行去重）。 */
    buildRegisteredName(ctx: {
        parentPresetName: string;
        profileName: string;
        existingNames: Set<string>;
    }): string;
}

/** 注册表抽象：name → 完整 preset 记录。 */
export interface PresetRegistry {
    /** 当前全部记录（name → record）。 */
    list(): Record<string, Record<string, any>>;
    /** 写入或覆盖一条记录。 */
    upsert(name: string, record: Record<string, any>): void;
    /** 删除一条记录。 */
    remove(name: string): void;
}

export interface RegisterProfileOptions {
    /** 父预设名（profile 归属；注册名的语义输入）。 */
    parentPresetName: string;
    profileId: string;
    profileName: string;
    /** 父预设关联键（marker 元数据；v3 下取父预设名）。 */
    parentKey: string;
    /** 解析后的完整快照（调用方 resolveProfilePrompts + entriesToSnapshot）。 */
    snapshot: PresetSnapshot;
    naming: PresetNaming;
}

export type RegisterResult =
    | { mode: 'created'; name: string }
    | { mode: 'rewritten'; name: string };

/** 注册/重写 profile 的投影 preset：已注册（marker 反查命中）→ 原名重写，不调命名策略；
 * 未注册 → naming 生成唯一名后新增。返回实际生效的注册名。 */
export function registerProfileAsPreset(registry: PresetRegistry, opts: RegisterProfileOptions): RegisterResult {
    const existing = findRegisteredPreset(registry, opts.profileId);
    if (existing) {
        registry.upsert(existing.name, buildProjectedPreset(opts.snapshot, buildProfileMarker(
            opts.parentKey, opts.profileId, opts.profileName, opts.parentPresetName,
        )));
        return { mode: 'rewritten', name: existing.name };
    }

    const name = opts.naming.buildRegisteredName({
        parentPresetName: opts.parentPresetName,
        profileName: opts.profileName,
        existingNames: new Set(Object.keys(registry.list())),
    });
    registry.upsert(name, buildProjectedPreset(opts.snapshot, buildProfileMarker(
        opts.parentKey, opts.profileId, opts.profileName, opts.parentPresetName,
    )));
    return { mode: 'created', name };
}

/** 按 profileId 反查已注册 preset 名（marker 扫描，与注册名格式无关）。 */
export function findProfilePresetName(registry: PresetRegistry, profileId: string): string | undefined {
    return findRegisteredPreset(registry, profileId)?.name;
}

/** 按 profileId 反查注册条目（name + 完整 marker）。 */
export function findRegisteredPreset(
    registry: PresetRegistry,
    profileId: string,
): { name: string; marker: NonNullable<ReturnType<typeof readPresetMarker>> } | undefined {
    for (const [name, record] of Object.entries(registry.list())) {
        const marker = readPresetMarker(record);
        if (marker && marker.kind === 'profile' && String(marker.profileId) === String(profileId)) {
            return { name, marker };
        }
    }
    return undefined;
}

/** 列出某父预设名下全部已注册的 profile 投影（marker.kind==='profile' && parentKey 匹配）。
 * 供同步对账：孤儿注册（profile 已删）由调用方据此注销。 */
export function findRegistrationsByParent(
    registry: PresetRegistry,
    parentKey: string,
): { name: string; marker: NonNullable<ReturnType<typeof readPresetMarker>> }[] {
    const out: { name: string; marker: NonNullable<ReturnType<typeof readPresetMarker>> }[] = [];
    for (const [name, record] of Object.entries(registry.list())) {
        const marker = readPresetMarker(record);
        if (marker && marker.kind === 'profile' && marker.parentKey === parentKey) {
            out.push({ name, marker });
        }
    }
    return out;
}

/** 注销 profile 的注册；不存在返回 false。 */
export function unregisterProfilePreset(registry: PresetRegistry, profileId: string): boolean {
    const existing = findRegisteredPreset(registry, profileId);
    if (!existing) return false;
    registry.remove(existing.name);
    return true;
}

/** 内容未变时返回 null（不重写、不落盘），避免无关持久化触发注册表刷新；否则同 registerProfileAsPreset。 */
export function registerProfileAsPresetIfChanged(
    registry: PresetRegistry,
    opts: RegisterProfileOptions,
): RegisterResult | null {
    const existing = findRegisteredPreset(registry, opts.profileId);
    if (existing) {
        const projected = buildProjectedPreset(opts.snapshot, buildProfileMarker(
            opts.parentKey, opts.profileId, opts.profileName, opts.parentPresetName,
        ));
        if (recordsEqual(registry.list()[existing.name], projected)) return null;
    }
    return registerProfileAsPreset(registry, opts);
}

/** 记录内容比较（投影记录为 JSON 可序列化数据）。 */
function recordsEqual(a: Record<string, any>, b: Record<string, any>): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}
