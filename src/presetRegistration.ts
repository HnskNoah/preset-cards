// presetRegistration：注册链路的 ST 适配层（切片 1）。
// core/registration 提供纯函数（注册/反查/对账/命名接口）；本文件实现：
//   - PresetRegistry：openai_settings 数组 + openai_setting_names 映射
//   - 占位命名策略（命名规则待定，可替换）
//   - 全量注册快照构建（applyProfileToPreset 克隆体 → 完整 preset 记录，含 sampling/extra/model）
//   - syncPresetRegistrations 对账（新增/重写/孤儿注销），订阅 meta 持久化自动触发
import { saveSettingsDebounced, getRequestHeaders } from '@sillytavern/script';
import { eventSource, event_types } from '@sillytavern/scripts/events';
import { openai_settings, openai_setting_names } from '@sillytavern/scripts/openai';
import { readMeta, onMetaPersisted, isPromptBaseProfile, isPromptDeltaProfile } from './meta.js';
import type { Preset, PromptBaseProfile, PromptDeltaProfile } from './meta.js';
import { setActiveProfile } from './activeProfile.js';
import { applyProfileToPreset } from './promptToggle.js';
import { buildProfileMarker, readPresetMarker } from './core/storage/marker.js';
import { buildProjectedPreset } from './core/storage/project.js';
import {
    findRegisteredPreset,
    findRegistrationsByParent,
    registerProfileAsPreset,
    registerProfileAsPresetIfChanged,
    type PresetRegistry,
    type PresetNaming,
} from './core/registration/register.js';

/** 单个 profile 的注册快照（已全量解析）。 */
export interface RegisteredProfileSnapshot {
    profileId: string;
    profileName: string;
    snapshot: Record<string, any>;
}

/** 占位命名策略：`父名 - profile名`，撞名加 ` (n)` 后缀。**命名规则待定**，定案时替换此实现即可。 */
export const placeholderNaming: PresetNaming = {
    buildRegisteredName: ({ parentPresetName, profileName, existingNames }) => {
        const base = `${parentPresetName} - ${profileName}`;
        if (!existingNames.has(base)) return base;
        let n = 2;
        while (existingNames.has(`${base} (${n})`)) n++;
        return `${base} (${n})`;
    },
};

/** ST 注册表适配：openai_settings 数组 + openai_setting_names 映射（对齐 saveOpenAIPreset 语义）。 */
export function createStRegistry(): PresetRegistry {
    return {
        list: () => {
            const out: Record<string, Record<string, any>> = {};
            for (const [name, index] of Object.entries(openai_setting_names)) {
                const record = openai_settings[index] as Record<string, any> | undefined;
                if (record) out[name] = record;
            }
            return out;
        },
        upsert: (name, record) => {
            const idx = openai_setting_names[name];
            if (idx !== undefined) {
                openai_settings[idx] = record;
                return;
            }
            openai_settings.push(record);
            openai_setting_names[name] = openai_settings.length - 1;
            appendDropdownOption(name, openai_settings.length - 1);
        },
        remove: (name) => {
            const idx = openai_setting_names[name];
            if (idx === undefined) return;
            // 服务端删除（对齐 deletePresetByName），失败不阻断本地清理
            void fetch('/api/presets/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ apiId: 'openai', name }),
            }).catch((err) => console.error('preset-cards: unregister preset delete failed', err));
            delete openai_setting_names[name];
            delete openai_settings[idx]; // 保留索引空洞（对齐 ST 删除语义，不 splice 位移）
            if (typeof document !== 'undefined') {
                const selectEl = document.querySelector('#settings_preset_openai') as HTMLSelectElement | null;
                selectEl?.querySelector(`option[value="${idx}"]`)?.remove();
            }
        },
    };
}

function appendDropdownOption(name: string, index: number): void {
    if (typeof document === 'undefined') return;
    const selectEl = document.querySelector('#settings_preset_openai') as HTMLSelectElement | null;
    if (!selectEl) return;
    const option = document.createElement('option');
    option.value = String(index);
    option.innerText = name;
    selectEl.appendChild(option);
}

/** 解析预设下全部 profile 的全量注册快照：克隆体 + applyProfileToPreset（含 sampling/extra/model 链式解析）。 */
export function buildRegisteredSnapshots(preset: Preset): RegisteredProfileSnapshot[] {
    const meta = readMeta(preset);
    const profiles = (meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]).filter(
        (p) => isPromptBaseProfile(p) || isPromptDeltaProfile(p),
    );
    return profiles.map((p) => {
        const clone = structuredClone(preset);
        applyProfileToPreset(clone, p, profiles, {
            showMissingToast: false,
            defaultSampling: meta.defaultSampling,
            defaultExtra: meta.defaultExtra,
            defaultModel: meta.defaultModel,
            defaultSnapshot: meta.defaultSnapshot,
        });
        return {
            profileId: String(p.id),
            profileName: p.name || String(p.id),
            snapshot: clone,
        };
    });
}

/**
 * 对账某预设的注册：未注册 → 新增；已注册且内容变化 → 重写；profile 已删 → 注销孤儿。
 * 内容未变时零写入（不触发 saveSettingsDebounced）。返回是否发生了变更。
 */
export function syncPresetRegistrations(presetName: string, presetIndex: number): boolean {
    const preset = openai_settings[presetIndex] as Preset | undefined;
    if (!preset) return false;
    const registry = createStRegistry();
    let touched = false;

    const snapshots = buildRegisteredSnapshots(preset);
    const currentIds = new Set(snapshots.map((s) => s.profileId));
    for (const reg of findRegistrationsByParent(registry, presetName)) {
        if (!currentIds.has(String(reg.marker.profileId))) {
            registry.remove(reg.name);
            touched = true;
        }
    }
    for (const s of snapshots) {
        const result = registerProfileAsPresetIfChanged(registry, {
            parentPresetName: presetName,
            profileId: s.profileId,
            profileName: s.profileName,
            parentKey: presetName,
            snapshot: s.snapshot,
            naming: placeholderNaming,
        });
        if (result !== null) touched = true;
    }
    if (touched) saveSettingsDebounced();
    return touched;
}

/** 注销某父预设名下全部注册（删除父预设时调用；不抛错，失败仅本地清理）。 */
export async function unregisterAllForPreset(presetName: string): Promise<void> {
    const registry = createStRegistry();
    const owned = findRegistrationsByParent(registry, presetName);
    for (const reg of owned) registry.remove(reg.name);
    if (owned.length > 0) saveSettingsDebounced();
}

/** 初始化：订阅 meta 持久化成功事件，自动对账注册。init.ts 调用一次。 */
export function initPresetRegistration(): void {
    onMetaPersisted((name, idx) => {
        try {
            syncPresetRegistrations(name, idx);
        } catch (err) {
            console.error('preset-cards: sync registrations failed', err);
        }
    });
}

/** 反查注册名（供卡片点击走 fastApply 用）。 */
export function findRegisteredPresetName(profileId: string): string | undefined {
    return findRegisteredPreset(createStRegistry(), profileId)?.name;
}

/** 切换前刷新单个 profile 的注册快照（注册链路：保证应用的是最新解析；原注册名不变）。 */
export function refreshRegisteredSnapshot(presetName: string, preset: Preset, profileId: string): string | undefined {
    const s = buildRegisteredSnapshots(preset).find((x) => x.profileId === String(profileId));
    if (!s) return undefined;
    const result = registerProfileAsPreset(createStRegistry(), {
        parentPresetName: presetName,
        profileId: s.profileId,
        profileName: s.profileName,
        parentKey: presetName,
        snapshot: s.snapshot,
        naming: placeholderNaming,
    });
    return result.name;
}

// ─── 切片 2：激活同步 ────────────────────────────────────────────────

/** 按父预设名 + profileId 解析最新**投影**注册记录（带身份 marker；父预设缺失返回 undefined）。
 * 必须返回投影记录而非裸快照：裸快照的 extensions.preset_cards 是父 meta 容器,
 * 写回存储会抹掉 marker → 卡片排除失败 + 捕获门读不到 marker。 */
export function resolveFreshRegisteredRecord(presetName: string, profileId: string): Record<string, any> | undefined {
    const idx = openai_setting_names[presetName];
    if (idx === undefined) return undefined;
    const parentPreset = openai_settings[idx] as Preset | undefined;
    if (!parentPreset) return undefined;
    const s = buildRegisteredSnapshots(parentPreset).find((x) => x.profileId === String(profileId));
    if (!s) return undefined;
    return buildProjectedPreset(s.snapshot, buildProfileMarker(
        presetName, s.profileId, s.profileName, presetName,
    ));
}

/** 从预设记录推导激活 profile 引用（纯函数）：profile 投影 → { presetName: 父预设名, profileId }；否则 undefined。 */
export function deriveActiveProfileRef(
    presetName: string,
    preset: Record<string, any> | undefined,
): { presetName: string; profileId: string } | undefined {
    const marker = readPresetMarker(preset);
    if (!marker || marker.kind !== 'profile' || !marker.profileId) return undefined;
    return { presetName: marker.parentKey ?? presetName, profileId: marker.profileId };
}

/**
 * 激活即最新解析：OAI_PRESET_CHANGED_BEFORE 钩子（ST 原生下拉与卡片 fastApply 都会触发）。
 * 传入预设带 profile marker → 沿父链重新解析，应用前覆盖 arg.preset + 写回 openai_settings[索引]
 * （保持注册记录新鲜）；无 marker → 不动。与 initPresetOrderNormalization 并列注册。
 */
export function initRegisteredPresetActivation(): void {
    eventSource.on(event_types.OAI_PRESET_CHANGED_BEFORE, (arg: any) => {
        try {
            const preset = arg?.preset as Record<string, any> | undefined;
            if (!preset) return;
            const marker = readPresetMarker(preset);
            if (!marker || marker.kind !== 'profile' || !marker.parentKey || !marker.profileId) return;
            const fresh = resolveFreshRegisteredRecord(marker.parentKey, marker.profileId);
            if (!fresh) return;
            // 应用前覆盖传入记录（native 路径是克隆；fastApply 路径即数组记录本体）
            Object.assign(preset, fresh);
            // 写回存储记录（保持注册记录新鲜 + 落盘）
            const storedIdx = typeof arg.presetName === 'string' ? openai_setting_names[arg.presetName] : undefined;
            if (storedIdx !== undefined) {
                openai_settings[storedIdx] = fresh;
                saveSettingsDebounced();
            }
        } catch (err) {
            console.error('preset-cards: before-hook re-resolve failed', err);
        }
    });
}

/** 原生切换激活了 profile（或清空）的通知；卡片高亮/外部扩展订阅。 */
export type ActiveProfileSwitchListener = (ref: { presetName: string; profileId: string } | undefined) => void;
const activeProfileSwitchListeners = new Set<ActiveProfileSwitchListener>();
export function onActiveProfileChangedBySwitch(listener: ActiveProfileSwitchListener): () => void {
    activeProfileSwitchListeners.add(listener);
    return () => { activeProfileSwitchListeners.delete(listener); };
}

/**
 * PRESET_CHANGED 观察者：只同步 activeProfile + 通知，绝不重复应用（ST 已应用快照）。
 * 激活 profile 投影 → setActiveProfile(父预设名, profileId) + 通知；普通预设 → 清空。
 */
export function initRegisteredPresetObserver(): void {
    eventSource.on(event_types.PRESET_CHANGED, (arg: any) => {
        try {
            const presetName = arg?.name as string | undefined;
            if (typeof presetName !== 'string') return;
            const idx = openai_setting_names[presetName];
            const ref = deriveActiveProfileRef(presetName, idx !== undefined ? openai_settings[idx] : undefined);
            if (ref) setActiveProfile(ref);
            else setActiveProfile(undefined);
            for (const listener of [...activeProfileSwitchListeners]) {
                listener(ref);
            }
        } catch (err) {
            console.error('preset-cards: preset-changed observer failed', err);
        }
    });
}
