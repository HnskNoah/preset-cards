// presetRegistration：注册链路的 ST 适配层（切片 1）。
// core/registration 提供纯函数（注册/反查/对账/命名接口）；本文件实现：
//   - PresetRegistry：openai_settings 数组 + openai_setting_names 映射
//   - 占位命名策略（命名规则待定，可替换）
//   - 全量注册快照构建（applyProfileToPreset 克隆体 → 完整 preset 记录，含 sampling/extra/model）
//   - syncPresetRegistrations 对账（新增/重写/孤儿注销），订阅 meta 持久化自动触发
import { saveSettingsDebounced, getRequestHeaders } from '@sillytavern/script';
import { eventSource, event_types } from '@sillytavern/scripts/events';
import { openai_settings, openai_setting_names, oai_settings } from '@sillytavern/scripts/openai';
import { readMeta, onMetaPersisted, isPromptBaseProfile, isPromptDeltaProfile } from './meta.js';
import type { Preset, PromptBaseProfile, PromptDeltaProfile } from './meta.js';
import { getActiveProfile, setActiveProfile } from './activeProfile.js';
import { applyProfileToPreset } from './promptToggle.js';
import { fastApplyPreset } from './fastApply.js';
import { whenCaptureSettled } from './presetCapture.js';
import { buildProfileMarker, readPresetMarker } from './core/storage/marker.js';
import { buildProjectedPreset } from './core/storage/project.js';
import {
    findRegisteredPreset,
    findRegistrationsByParent,
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

/** 预设注册表条目变化监听器（upsert/remove 触发）。 */
type PresetRegistryListener = () => void;
const presetRegistryListeners = new Set<PresetRegistryListener>();

/** 订阅预设注册表条目变化（新增/改写/删除条目时触发），返回退订函数。 */
export function onPresetRegistryChanged(listener: PresetRegistryListener): () => void {
    presetRegistryListeners.add(listener);
    return () => { presetRegistryListeners.delete(listener); };
}

function notifyPresetRegistryChanged(): void {
    for (const listener of [...presetRegistryListeners]) {
        try {
            listener();
        } catch (err) {
            console.error('preset-cards: preset registry listener failed', err);
        }
    }
}

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
            // 服务端写预设文件：ST 预设为文件型存储（settings 保存 payload 不含 openai_settings 数组，
            // 服务端 settings.js:236-239 从预设目录重建）——只改本地数组 reload 后投影会消失。
            void fetch('/api/presets/save', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ apiId: 'openai', name, preset: record }),
            }).catch((err) => console.error('preset-cards: register preset save failed', err));
            const idx = openai_setting_names[name];
            if (idx !== undefined) {
                openai_settings[idx] = record;
                notifyPresetRegistryChanged();
                return;
            }
            openai_settings.push(record);
            openai_setting_names[name] = openai_settings.length - 1;
            appendDropdownOption(name, openai_settings.length - 1);
            notifyPresetRegistryChanged();
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
            notifyPresetRegistryChanged();
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
export function syncPresetRegistrations(presetName: string, _presetIndex?: number): boolean {
    // 父预设已被删除(原生删除会清 openai_setting_names;数组元素可能残留)时跳过对账,
    // 避免在途 meta 保存的 onMetaPersisted 用残留记录重建孤儿投影(与 doSaveMeta 同守卫)
    if (openai_setting_names[presetName] === undefined) return false;
    // 索引以映射表当前值为准（调用方闭包捕获的索引可能因数组重建/同名替换过期,
    // 用旧索引会把别的预设当父注册,连带 marker.parentKey 错标与孤儿清扫误删）
    const preset = openai_settings[openai_setting_names[presetName]] as Preset | undefined;
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
    if (touched) {
        saveSettingsDebounced();
        // NEW-2：对账刷新了投影记录后,若该父预设的投影正激活,立即重应用——
        // 否则运行时停留在旧状态,下次 SETTINGS_UPDATED 捕获会把它当漂移回写,静默撤销
        // 编辑器提交/插件侧改动(也顺带解决"捕获后运行时直到下次激活才更新"的缺口)
        refreshProjectionRuntimeIfActive(presetName);
    }
    return touched;
}

/** 若活动预设是某父预设的 profile 投影,重应用其最新记录（保持运行时与投影记录一致）。
 * 先等捕获周期（含持久化窗口内被挡事件的待重跑轮）落定再应用——否则窗口内的用户编辑
 * 会被旧时点记录覆盖丢失（编辑 A 触发捕获 → 持久化期间编辑 B 被防重入记为待重跑 →
 * 若立刻用 A 时点记录重应用,B 即被抹掉）。
 * refreshing 防级联重入：捕获落盘 → onMetaPersisted → sync → 本函数的递归调用直接跳过,
 * 由本次调用的收尾 fastApply 统一应用最新记录。 */
let refreshing = false;
export function refreshProjectionRuntimeIfActive(parentPresetName: string): void {
    const activeName = oai_settings.preset_settings_openai;
    if (typeof activeName !== 'string') return;
    const idx = openai_setting_names[activeName];
    if (idx === undefined) return;
    const marker = readPresetMarker(openai_settings[idx]);
    if (!marker || marker.kind !== 'profile' || marker.parentKey !== parentPresetName) return;
    if (refreshing) return;
    refreshing = true;
    void whenCaptureSettled()
        .then(() => {
            refreshing = false;
            // 捕获窗口（合并窗口 + 网络 RTT，可被待重跑轮延长）内用户可能已切换预设：
            // 仅当活动名未变时才重应用——fastApplyPreset 会无条件改写 preset_settings_openai，
            // 否则会把用户显式切走的选择静默拉回本投影。
            if (oai_settings.preset_settings_openai !== activeName) return;
            // 捕获周期(及其触发的对账级联)完成后应用最新记录;级联内已被 refreshing 拦截,此处为唯一应用点
            void fastApplyPreset(idx, activeName).catch((err) => console.error('preset-cards: fastApply failed', err));
        });
}

/** 注销某父预设名下全部注册（删除父预设时调用；不抛错，失败仅本地清理）。
 * 返回被注销的注册名列表（供调用方清理悬空的活动指针/activeProfile 引用）。 */
export async function unregisterAllForPreset(presetName: string): Promise<string[]> {
    const registry = createStRegistry();
    const owned = findRegistrationsByParent(registry, presetName);
    for (const reg of owned) registry.remove(reg.name);
    if (owned.length > 0) saveSettingsDebounced();
    return owned.map((reg) => reg.name);
}

/** 初始化：订阅 meta 持久化成功事件，自动对账注册；并在设置加载后全量对账一次
 * （reload 后服务端按预设文件重建 openai_settings,需要把已有 profile 重新注册为投影）。init.ts 调用一次。 */
export function initPresetRegistration(): void {
    onMetaPersisted((name, idx) => {
        try {
            syncPresetRegistrations(name, idx);
        } catch (err) {
            console.error('preset-cards: sync registrations failed', err);
        }
    });
    eventSource.on(event_types.SETTINGS_LOADED, () => {
        try {
            syncAllPresetRegistrations();
        } catch (err) {
            console.error('preset-cards: startup registration sync failed', err);
        }
    });
    // ST 原生删除预设(openai.js onDeletePresetClick emit PRESET_DELETED):若删的是父预设,
    // 其名下注册投影是独立预设文件,不会随之删除 → 清理(zombie 防残留);删注册投影本身则 no-op。
    eventSource.on(event_types.PRESET_DELETED, (arg: any) => {
        const name = typeof arg?.name === 'string' ? arg.name : undefined;
        if (!name) return;
        // 无论该预设名下有无注册投影都通知（向导等列表 UI 需要感知条目消失）
        notifyPresetRegistryChanged();
        try {
            void unregisterAllForPreset(name).then((removedNames) => {
                // 删除的父预设若有激活中的投影：投影刚被注销，ST 不会重置指向它的活动指针
                //（原生只处理「删的就是活动预设」），悬空引用会残留到 settings.json 并让
                // getActiveProfile() 持续报告已删除的 profile——与插件删除路径对齐，这里清掉。
                if (oai_settings.preset_settings_openai !== null
                    && removedNames.includes(String(oai_settings.preset_settings_openai))) {
                    oai_settings.preset_settings_openai = null;
                    saveSettingsDebounced();
                }
                const activeRef = getActiveProfile();
                if (activeRef && activeRef.presetName === name) {
                    setActiveProfile(undefined);
                }
            });
        } catch (err) {
            console.error('preset-cards: cleanup registrations on preset delete failed', err);
        }
    });
    // ST 原生导入/保存预设（openai.js saveOpenAIPreset）不发 eventSource 事件，
    // 只 trigger #settings_preset_openai 的 change——委托转发进注册表变更通知。
    // 守卫：纯逻辑单测（node 环境）无 DOM/jQuery。
    if (typeof document !== 'undefined' && typeof $ === 'function') {
        $(document).on('change.presetCards', '#settings_preset_openai', () => notifyPresetRegistryChanged());
    }
}

/** 全量对账（幂等；启动/reload 后调用）：存活预设的 profile 全部注册/重写；
 * 再清扫孤儿——注册投影的父预设已不存在（原生/外部删除）时注销（防 zombie 跨 reload 残留）。 */
export function syncAllPresetRegistrations(): void {
    for (const [name, idx] of Object.entries(openai_setting_names)) {
        try {
            syncPresetRegistrations(name, idx);
        } catch (err) {
            console.error('preset-cards: sync registrations failed', err);
        }
    }
    const registry = createStRegistry();
    const live = new Set(Object.keys(openai_setting_names));
    for (const [name, record] of Object.entries(registry.list())) {
        const marker = readPresetMarker(record);
        if (marker && marker.kind === 'profile' && marker.parentKey && !live.has(marker.parentKey)) {
            try {
                registry.remove(name);
            } catch (err) {
                console.error('preset-cards: orphan registration cleanup failed', err);
            }
        }
    }
}

/** 反查注册名（供卡片点击走 fastApply 用）。parentKey 限定可防跨预设同 id 误命中。 */
export function findRegisteredPresetName(profileId: string, parentKey?: string): string | undefined {
    return findRegisteredPreset(createStRegistry(), profileId, parentKey)?.name;
}

/** 切换前刷新单个 profile 的注册快照（注册链路：保证应用的是最新解析；原注册名不变）。
 * 用 IfChanged 语义：内容未变时不重写、不触发 /api/presets/save（L19）。 */
export function refreshRegisteredSnapshot(presetName: string, preset: Preset, profileId: string): string | undefined {
    const s = buildRegisteredSnapshots(preset).find((x) => x.profileId === String(profileId));
    if (!s) return undefined;
    const registry = createStRegistry();
    const existing = findRegisteredPreset(registry, profileId, presetName);
    const result = registerProfileAsPresetIfChanged(registry, {
        parentPresetName: presetName,
        profileId: s.profileId,
        profileName: s.profileName,
        parentKey: presetName,
        snapshot: s.snapshot,
        naming: placeholderNaming,
    });
    return result ? result.name : existing?.name;
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
            // 应用前完整替换传入记录（native 路径是克隆；fastApply 路径即数组记录本体）。
            // 先删去 fresh 已不存在的键，避免旧投影字段在本次切换中继续被 ST 应用。
            for (const key of Object.keys(preset)) {
                if (!Object.hasOwn(fresh, key)) delete preset[key];
            }
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
            if (ref) {
                setActiveProfile(ref);
            } else {
                // 字段级加载路径（applyProfileToPresetByName）把 profile 应用到父预设后,
                // PRESET_CHANGED 落在父预设（无 marker）——若当前激活标记的 presetName 就是新活动名,
                // 保留激活标记（父预设此刻就是该 profile 的状态），否则清空（切到无关预设）。
                const active = getActiveProfile();
                if (!(active && active.presetName === presetName)) setActiveProfile(undefined);
            }
            for (const listener of [...activeProfileSwitchListeners]) {
                listener(ref);
            }
        } catch (err) {
            console.error('preset-cards: preset-changed observer failed', err);
        }
    });
}
