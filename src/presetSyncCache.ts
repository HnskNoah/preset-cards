// presetSyncCache：注册对账的增量缓存。
// 痛点：syncPresetRegistrations 每次 meta 落盘都对全部 profile 各克隆一份整个预设并全量解析，
// MB 级预设 × N 个 profile = 每次保存 N+1 次全量深拷贝（IfChanged 只省 POST，省不掉克隆）。
// 方案：投影输出 = f(profile 链内容, 出厂基线, prompts 池, prompt_order, 写入目标)，
// 全部输入编入指纹；指纹命中 → 复用上次构建的投影快照，跳过克隆与解析。
// 缓存挂在预设对象身份上（WeakMap）：同名替换/reload 自动失效，无需手工清理。
import { isPromptBaseProfile, isPromptDeltaProfile, readMeta, type Preset, type PresetProfile } from './meta.js';
import { applyProfileToPreset, resolvePromptOrderTarget } from './promptToggle.js';
import { EXTENSION_KEY } from './constants.js';
import { hash64, profileChainFingerprint } from './core/registration/register.js';
import { stableStringify } from './stableStringify.js';

/** 单个 profile 的全量投影快照（已应用 profile 到预设克隆体）。 */
export interface RegisteredProfileSnapshot {
    profileId: string;
    profileName: string;
    snapshot: Record<string, any>;
}

interface PresetSyncCache {
    /** 环境输入指纹（基线四件套 + prompts 池 + prompt_order + 写入目标）：任一变化全体重建。 */
    envKey: string;
    perProfile: Map<string, { fingerprint: string; snapshot: Record<string, any> }>;
}

const cacheByPreset = new WeakMap<object, PresetSyncCache>();

/** 环境键：投影输出依赖的「非 profile」输入，一次哈希全体共享。
 * 投影记录 = 整个预设克隆体的透传（本体任意顶层键、extensions 其他扩展都会流入），因此环境必须
 * 取整个预设本体；仅扣除 extensions['preset_cards']（meta 容器不是投影输入——buildProjectedPreset
 * 用 marker 覆盖它，且它每次 meta 落盘都变，计入会使缓存永远失效）。基线四件套在容器内、是真实
 * 输入，单独编入。stableStringify 全本体是本方案唯一 O(预设) 的开销（单趟字符串化 ≪ N 次深拷贝+解析）。 */
function computeEnvKey(preset: Preset, meta: ReturnType<typeof readMeta>): string {
    const ext = (preset.extensions && typeof preset.extensions === 'object')
        ? { ...preset.extensions }
        : undefined;
    if (ext && Object.hasOwn(ext, EXTENSION_KEY)) ext[EXTENSION_KEY] = null;
    return hash64(stableStringify([
        { ...preset, extensions: ext },
        meta.defaultSnapshot ?? null,
        meta.defaultSnapshotLocked === true,
        meta.defaultSampling ?? null,
        meta.defaultExtra ?? null,
        meta.defaultModel ?? null,
        resolvePromptOrderTarget(),
    ]));
}

/** 带缓存的注册快照构建：指纹命中复用上次快照，未命中才 structuredClone + 全量解析。
 * 与 buildRegisteredSnapshots 输出逐字节一致（后者保留给激活/加载等必须新鲜的单点路径）。 */
export function buildRegisteredSnapshotsCached(preset: Preset): RegisteredProfileSnapshot[] {
    const meta = readMeta(preset);
    const profiles = (Array.isArray(meta.profiles) ? meta.profiles : []).filter(
        (p): p is PresetProfile => isPromptBaseProfile(p) || isPromptDeltaProfile(p),
    );

    const envKey = computeEnvKey(preset, meta);
    let cache = cacheByPreset.get(preset);
    if (!cache || cache.envKey !== envKey) {
        cache = { envKey, perProfile: new Map() };
        cacheByPreset.set(preset, cache);
    }

    const out: RegisteredProfileSnapshot[] = [];
    for (const p of profiles) {
        const id = String(p.id);
        const fingerprint = profileChainFingerprint(p, profiles as PresetProfile[]);
        const cached = cache.perProfile.get(id);
        let snapshot = cached?.fingerprint === fingerprint ? cached.snapshot : undefined;
        if (!snapshot) {
            snapshot = structuredClone(preset);
            applyProfileToPreset(snapshot, p, profiles, {
                showMissingToast: false,
                defaultSampling: meta.defaultSampling,
                defaultExtra: meta.defaultExtra,
                defaultModel: meta.defaultModel,
                defaultSnapshot: meta.defaultSnapshot,
            });
            cache.perProfile.set(id, { fingerprint, snapshot });
        }
        out.push({ profileId: id, profileName: p.name || id, snapshot });
    }
    // 已删 profile 的缓存条目随手清（孤儿注销逻辑照旧按注册表反查，不依赖缓存）
    if (cache.perProfile.size > profiles.length) {
        const ids = new Set(profiles.map((p) => String(p.id)));
        for (const key of [...cache.perProfile.keys()]) {
            if (!ids.has(key)) cache.perProfile.delete(key);
        }
    }
    return out;
}
