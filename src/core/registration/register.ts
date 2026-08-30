// core/registration：profile → ST preset 注册/反查/清理（零 ST 依赖，纯函数）。
// 注册表用 PresetRegistry 抽象（ST 适配层实现为 openai_settings + openai_setting_names）；
// 命名策略 PresetNaming 可注入——注册名格式与去重规则待定，不阻塞注册流程。

import type { PresetProfile, PresetSnapshot } from '../domain/types.js';
import { isPromptDeltaProfile } from '../domain/schema.js';
import { buildProfileMarker, readPresetMarker } from '../storage/marker.js';
import { buildProjectedPreset } from '../storage/project.js';
import { stableStringify } from '../../stableStringify.js';

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
 * 未注册 → naming 生成唯一名后新增。profile 重命名（marker.profileName 变化）时注册名跟随
 * （naming 重新取唯一名并迁移记录）。返回实际生效的注册名。 */
export function registerProfileAsPreset(registry: PresetRegistry, opts: RegisterProfileOptions): RegisterResult {
    const existing = findRegisteredPreset(registry, opts.profileId, opts.parentKey);
    if (existing) {
        const projected = buildProjectedPreset(opts.snapshot, buildProfileMarker(
            opts.parentKey, opts.profileId, opts.profileName, opts.parentPresetName,
        ));
        const renamed = existing.marker.profileName !== opts.profileName;
        if (renamed) {
            const name = opts.naming.buildRegisteredName({
                parentPresetName: opts.parentPresetName,
                profileName: opts.profileName,
                existingNames: new Set(Object.keys(registry.list()).filter((n) => n !== existing.name)),
            });
            if (name !== existing.name) {
                registry.remove(existing.name);
                registry.upsert(name, projected);
                return { mode: 'rewritten', name };
            }
        }
        registry.upsert(existing.name, projected);
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

/** 按 profileId（可选限定父预设）反查已注册 preset 名（marker 扫描，与注册名格式无关）。 */
export function findProfilePresetName(registry: PresetRegistry, profileId: string, parentKey?: string): string | undefined {
    return findRegisteredPreset(registry, profileId, parentKey)?.name;
}

/** 按 profileId（可选限定父预设）反查注册条目（name + 完整 marker）。
 * parentKey 限定可防跨预设同 profileId（如 ST 原生导入 verbatim 保留 id）错误命中。 */
export function findRegisteredPreset(
    registry: PresetRegistry,
    profileId: string,
    parentKey?: string,
): { name: string; marker: NonNullable<ReturnType<typeof readPresetMarker>> } | undefined {
    for (const [name, record] of Object.entries(registry.list())) {
        const marker = readPresetMarker(record);
        if (marker && marker.kind === 'profile' && String(marker.profileId) === String(profileId)
            && (parentKey === undefined || marker.parentKey === parentKey)) {
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
    const existing = findRegisteredPreset(registry, opts.profileId, opts.parentKey);
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

/** 同步 64 位哈希（双 32 位乘法混合拼接为 16 进制）。仅用于对账指纹比较，非加密用途。 */
export function hash64(input: string): string {
    let h1 = 0x811c9dc5 | 0;
    let h2 = 0x0f2f5a1b | 0;
    for (let i = 0; i < input.length; i++) {
        const c = input.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** 单配置链式指纹（纯函数）：base = H(自身内容)；delta = H(自身内容 ⊕ 父链逐层内容)。
 * 父链任何一层变化都会传播到全部后代指纹——后代投影依赖父链解析，父变即须重建；
 * 成环/父缺失按已收集部分收口（与 resolveProfilePrompts 防环一致，不死循环）。 */
export function profileChainFingerprint(
    profile: PresetProfile,
    allProfiles: PresetProfile[],
): string {
    const seen = new Set<string>([String(profile.id)]);
    let fp = hash64(stableStringify(profile));
    let current: PresetProfile | undefined = isPromptDeltaProfile(profile) ? profile : undefined;
    while (current) {
        const node: PresetProfile = current;
        const parent: PresetProfile | undefined = allProfiles.find((q) => String(q.id) === String(node.baseId));
        if (!parent || seen.has(String(parent.id))) break;
        seen.add(String(parent.id));
        fp = hash64(fp + '|' + stableStringify(parent));
        current = isPromptDeltaProfile(parent) ? parent : undefined;
    }
    return fp;
}
