import { oai_settings, promptManager } from '@sillytavern/scripts/openai';
import { L } from './i18n.js';
import { isPromptBaseProfile, isPromptDeltaProfile } from './meta.js';
import { PROMPT_FIELD_KEYS } from './profileSchema.js';
import type {
    Preset,
    PresetProfile,
    PromptBaseProfile,
    PromptDefaultSnapshotEntry,
    PromptDeltaChange,
    PromptDeltaProfile,
    PromptFields,
    PromptProfileEntry,
} from './meta.js';
import {
    applyPromptDelta,
    arrangePromptEntries,
    diffPromptState,
    mountedOrder,
    promptOrderTarget,
    replacementPromptOrder,
    snapshotPromptState,
} from './promptState.js';

export const PROMPT_FIELD_WHITELIST: (keyof PromptFields)[] = [...PROMPT_FIELD_KEYS];

export function promptFieldsEqual(a: PromptFields, b: PromptFields): boolean {
    return PROMPT_FIELD_WHITELIST.every((key) => a[key] === b[key]);
}

export function capturePromptFields(prompt: Record<string, any> | undefined): PromptFields {
    const fields: PromptFields = {};
    if (!prompt) return fields;
    for (const key of PROMPT_FIELD_WHITELIST) {
        if (prompt[key] !== undefined) fields[key] = prompt[key];
    }
    return fields;
}

export function filterFields(fields: Record<string, any> | undefined): PromptFields {
    const out: PromptFields = {};
    if (!fields) return out;
    for (const key of PROMPT_FIELD_WHITELIST) {
        if (fields[key] !== undefined) out[key] = fields[key];
    }
    return out;
}

export function mirrorFieldsToActivePreset(presetName: string, identifier: string, fields: PromptFields): void {
    if (oai_settings.preset_settings_openai !== presetName) return;
    const livePrompts = Array.isArray(oai_settings.prompts) ? oai_settings.prompts : [];
    const livePrompt = livePrompts.find((prompt: any) => prompt?.identifier === identifier);
    if (livePrompt) Object.assign(livePrompt, filterFields(fields));
}

export function findPromptInPreset(preset: Preset, identifier: string): any | undefined {
    const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    return prompts.find((prompt: any) => prompt?.identifier === identifier);
}

export function findOrderList(preset: Preset, characterId: number | string): any {
    if (!Array.isArray(preset.prompt_order)) return undefined;
    return preset.prompt_order.find((entry: any) => entry && String(entry.character_id) === String(characterId));
}

export function resolvePromptOrderTarget(): number {
    return promptOrderTarget(
        promptManager?.configuration?.promptOrder?.strategy,
        promptManager?.activeCharacter?.id,
    );
}

export interface RuntimePromptState {
    mounted: boolean;
    enabled: boolean;
    lastActiveIndex?: number;
}

export function runtimePromptStateFor(
    prompt: { identifier: string; enabled?: boolean },
    preset: Preset,
    characterId: number | string = resolvePromptOrderTarget(),
): RuntimePromptState {
    const list = findOrderList(preset, characterId);
    if (Array.isArray(list?.order)) {
        const index = list.order.findIndex((entry: any) => entry?.identifier === prompt.identifier);
        if (index >= 0) {
            const orderEntry = list.order[index];
            return {
                mounted: true,
                enabled: typeof orderEntry.enabled === 'boolean' ? orderEntry.enabled : (prompt.enabled ?? true),
                lastActiveIndex: index,
            };
        }
    }
    return { mounted: false, enabled: false };
}

export function runtimeEnabledFor(
    prompt: { identifier: string; enabled?: boolean },
    preset: Preset,
    characterId: number | string = resolvePromptOrderTarget(),
): boolean {
    return runtimePromptStateFor(prompt, preset, characterId).enabled;
}

export function syncPromptOrder(preset: Preset, entries: { identifier: string; enabled: boolean }[]): void {
    const list = findOrderList(preset, resolvePromptOrderTarget());
    if (!Array.isArray(list?.order)) return;
    for (const entry of entries) {
        const existing = list.order.find((orderEntry: any) => orderEntry?.identifier === entry.identifier);
        if (existing) existing.enabled = entry.enabled;
    }
}

export function applyEntryState(preset: Preset, identifier: string, enabled: boolean): boolean {
    const prompt = findPromptInPreset(preset, identifier);
    if (!prompt) return false;
    prompt.enabled = enabled;
    syncPromptOrder(preset, [{ identifier, enabled }]);
    return true;
}

export function replaceTargetPromptOrder(
    preset: Preset,
    entries: PromptProfileEntry[],
    characterId: number | string = resolvePromptOrderTarget(),
): void {
    if (!Array.isArray(preset.prompt_order)) preset.prompt_order = [];
    let list = findOrderList(preset, characterId);
    if (!list) {
        list = { character_id: characterId, order: [] };
        preset.prompt_order.push(list);
    }
    const existing = new Map<string, any>(
        (Array.isArray(list.order) ? list.order : [])
            .filter((entry: any) => entry && typeof entry.identifier === 'string')
            .map((entry: any) => [entry.identifier, entry]),
    );
    const validIds = new Set(
        (Array.isArray(preset.prompts) ? preset.prompts : [])
            .filter((prompt: any) => prompt && typeof prompt.identifier === 'string')
            .map((prompt: any) => prompt.identifier),
    );
    list.order = replacementPromptOrder(entries, validIds)
        .map((entry) => ({ ...existing.get(entry.identifier), ...entry }));
}

export function pruneStaleOrderEntries(preset: Preset): void {
    if (!Array.isArray(preset.prompts)) return;
    const list = findOrderList(preset, resolvePromptOrderTarget());
    if (!Array.isArray(list?.order)) return;
    const validIds = new Set(preset.prompts.map((prompt: any) => prompt?.identifier).filter(Boolean));
    list.order = list.order.filter((entry: any) => entry && validIds.has(entry.identifier));
}

export function buildPromptSnapshot(
    preset: Preset,
    opts?: { includeFields?: Set<string> },
): PromptProfileEntry[] {
    if (!Array.isArray(preset.prompts)) return [];
    const target = resolvePromptOrderTarget();
    const prompts = preset.prompts.filter((prompt: any) => prompt && typeof prompt.identifier === 'string' && prompt.identifier);
    const list = findOrderList(preset, target);
    const entries = snapshotPromptState(prompts, Array.isArray(list?.order) ? list.order : []);
    for (const entry of entries) {
        if (opts?.includeFields?.has(entry.identifier)) {
            entry.fields = capturePromptFields(findPromptInPreset(preset, entry.identifier));
        }
    }
    return entries;
}

export function buildDefaultSnapshotLock(preset: Preset): PromptDefaultSnapshotEntry[] {
    return buildPromptSnapshot(preset, {
        includeFields: new Set(
            (Array.isArray(preset.prompts) ? preset.prompts : [])
                .map((prompt: any) => prompt?.identifier)
                .filter((identifier: unknown): identifier is string => typeof identifier === 'string'),
        ),
    }).map((entry) => ({
        identifier: entry.identifier,
        mounted: entry.mounted,
        enabled: entry.enabled,
        lastActiveIndex: entry.lastActiveIndex,
        originalFields: entry.fields,
    }));
}

export function buildBaseSnapshotDiff(
    preset: Preset,
    baseline: PromptDefaultSnapshotEntry[] | null | undefined,
): PromptProfileEntry[] {
    const snapshot = buildPromptSnapshot(preset);
    const baselineFields = new Map<string, PromptFields>();
    for (const entry of baseline ?? []) {
        if (entry.originalFields) baselineFields.set(entry.identifier, entry.originalFields);
    }
    for (const entry of snapshot) {
        const prompt = findPromptInPreset(preset, entry.identifier);
        const current = capturePromptFields(prompt);
        const original = baselineFields.get(entry.identifier);
        if (!original) {
            if (Object.keys(current).length > 0) entry.fields = current;
            continue;
        }
        const diff: PromptFields = {};
        for (const key of PROMPT_FIELD_WHITELIST) {
            if (current[key] !== undefined && current[key] !== original[key]) {
                (diff as Record<string, any>)[key] = current[key];
            }
        }
        if (Object.keys(diff).length > 0) entry.fields = diff;
    }
    return snapshot;
}

export function resolveProfilePrompts(
    profile: PromptBaseProfile | PromptDeltaProfile,
    allProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
    seen: Set<string> = new Set(),
): PromptProfileEntry[] {
    if (!profile || seen.has(profile.id)) return [];
    seen.add(profile.id);
    if (isPromptBaseProfile(profile)) return arrangePromptEntries(structuredClone(profile.prompts), mountedOrder(profile.prompts));
    if (!isPromptDeltaProfile(profile)) return [];
    const parent = allProfiles.find((candidate) => candidate.id === profile.baseId);
    if (!parent) return [];
    return applyPromptDelta(resolveProfilePrompts(parent, allProfiles, seen), profile.changes, profile.order);
}

export function resolveParentStates(
    profile: PromptDeltaProfile,
    allProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
): PromptProfileEntry[] {
    const parent = allProfiles.find((candidate) => candidate.id === profile.baseId);
    return parent ? resolveProfilePrompts(parent, allProfiles) : [];
}

export function applyResolvedPromptState(
    preset: Preset,
    entries: PromptProfileEntry[],
): { matched: number; missing: string[] } {
    const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    const byId = new Map<string, any>(prompts.filter((prompt: any) => prompt?.identifier).map((prompt: any) => [prompt.identifier, prompt]));
    const missing: string[] = [];
    let matched = 0;
    for (const entry of entries) {
        const prompt = byId.get(entry.identifier);
        if (!prompt) {
            missing.push(entry.identifier);
            continue;
        }
        if (entry.mounted) prompt.enabled = entry.enabled;
        if (entry.fields) Object.assign(prompt, filterFields(entry.fields));
        matched++;
    }
    replaceTargetPromptOrder(preset, entries);
    return { matched, missing };
}

export function applyBaseProfile(preset: Preset, profile: PromptBaseProfile): void {
    applyResolvedPromptState(preset, profile.prompts);
}

export function applyDeltaProfile(
    preset: Preset,
    delta: PromptDeltaProfile,
    allProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
): { matched: number; missing: string[] } {
    return applyResolvedPromptState(preset, resolveProfilePrompts(delta, allProfiles));
}

export function snapshotToDelta(
    snapshot: PromptProfileEntry[],
    parentEntries: PromptProfileEntry[],
): { changes: PromptDeltaChange[]; order?: string[] } {
    const delta = diffPromptState(snapshot, parentEntries);
    return { changes: delta.changes as PromptDeltaChange[], order: delta.order };
}

export function snapshotToChanges(
    snapshot: PromptProfileEntry[],
    parentEntries: PromptProfileEntry[],
    _previousChanges: PromptDeltaChange[] = [],
): PromptDeltaChange[] {
    return snapshotToDelta(snapshot, parentEntries).changes;
}

export function applyProfileToPreset(
    preset: Preset,
    profile: PresetProfile,
    allProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
    opts?: { showMissingToast?: boolean },
): boolean {
    if (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile)) {
        toastr.warning(L('This profile type cannot be edited with switches'));
        return false;
    }
    pruneStaleOrderEntries(preset);
    const states = resolveProfilePrompts(profile, allProfiles);
    if (states.length === 0 && isPromptDeltaProfile(profile)) {
        toastr.warning(L('Base profile not found, applying changes only'));
        return false;
    }
    const { missing } = applyResolvedPromptState(preset, states);
    if (opts?.showMissingToast && missing.length > 0) {
        toastr.warning(`${L('Missing prompts skipped')}: ${missing.join(', ')}`);
    }
    return true;
}
