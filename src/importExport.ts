import { POPUP_TYPE, callGenericPopup } from '@sillytavern/scripts/popup';
import { L } from './i18n.js';
import {
    isPromptBaseProfile,
    isPromptDeltaProfile,
    newProfileId,
    type PresetMeta,
    type PresetProfile,
    type PromptBaseProfile,
    type PromptDeltaProfile,
} from './meta.js';
import { resolveParentStates } from './promptToggle.js';
import {
    prepareImportedBaseProfile,
    prepareImportedDeltaProfile,
    prepareImportedTree,
} from './profileImportState.js';
import {
    assertV3ImportPayload,
    isV3BaseProfileData,
    LegacyProfileFormatError,
} from './profileSchema.js';
export { LegacyProfileFormatError } from './profileSchema.js';

export function chooseProfileSaveTarget(): Promise<'update' | 'create' | null> {
    return chooseFromOptions(L('Save changes to'), [
        [L('Update current profile'), 'update'],
        [L('Create new subprofile'), 'create'],
    ]);
}

export function chooseProfileExportAction(): Promise<'profile' | 'tree' | null> {
    return chooseFromOptions(L('Export configuration'), [
        [L('Export'), 'profile'],
        [L('Export with branch chain'), 'tree'],
    ]);
}

export async function chooseFromOptions<T extends string>(title: string, options: [label: string, value: T][]): Promise<T | null> {
    const container = $('<div class="preset_cards_save_choice"></div>');
    container.append($('<div class="preset_cards_save_choice_title"></div>').text(title));
    const buttons = $('<div class="preset_cards_save_choice_actions"></div>');
    for (const [label, value] of options) {
        buttons.append($('<button class="menu_button"></button>').text(label).on('click', () => resolveChoice(value)));
    }
    buttons.append($('<button class="menu_button"></button>').text(L('Cancel')).on('click', () => resolveChoice(null)));
    container.append(buttons);

    let resolver: (value: T | null) => void = () => undefined;
    let settled = false;
    const promise = new Promise<T | null>((resolve) => { resolver = resolve; });
    function resolveChoice(value: T | null): void {
        if (settled) return;
        settled = true;
        resolver(value);
        container.closest('.popup').find('.popup-controls .menu_button').click();
    }
    callGenericPopup(container, POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: '',
        onClose: () => resolveChoice(null),
    });
    return promise;
}

function isBaseData(value: unknown): value is PromptBaseProfile {
    return isV3BaseProfileData(value);
}

export function buildProfileExportData(profile: PresetProfile, meta: PresetMeta): string {
    if (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile)) throw new LegacyProfileFormatError();
    const defaultData = meta.defaultSnapshot?.length
        ? { defaultSnapshot: meta.defaultSnapshot, defaultSnapshotLocked: meta.defaultSnapshotLocked === true }
        : {};
    if (isPromptBaseProfile(profile)) {
        return JSON.stringify({ ...structuredClone(profile), ...defaultData }, null, 4);
    }
    const parentPrompts = resolveParentStates(profile, meta.profiles.filter(
        (candidate): candidate is PromptBaseProfile | PromptDeltaProfile => isPromptBaseProfile(candidate) || isPromptDeltaProfile(candidate),
    ));
    return JSON.stringify({
        ...structuredClone(profile),
        base: {
            formatVersion: 3,
            kind: 'prompt_base',
            id: profile.baseId,
            name: 'Imported Parent',
            prompts: parentPrompts,
        },
        ...defaultData,
    }, null, 4);
}

export function buildTreeExportData(meta: PresetMeta, targetId?: string): string {
    const profiles = meta.profiles.filter(
        (profile): profile is PromptBaseProfile | PromptDeltaProfile => isPromptBaseProfile(profile) || isPromptDeltaProfile(profile),
    );
    const children = new Map<string, PromptDeltaProfile[]>();
    for (const profile of profiles) {
        if (!isPromptDeltaProfile(profile)) continue;
        const list = children.get(profile.baseId) ?? [];
        list.push(profile);
        children.set(profile.baseId, list);
    }
    const ordered: (PromptBaseProfile | PromptDeltaProfile)[] = [];
    const visited = new Set<string>();
    const visit = (profile: PromptBaseProfile | PromptDeltaProfile): void => {
        if (visited.has(profile.id)) return;
        if (isPromptDeltaProfile(profile)) {
            const parent = profiles.find((candidate) => candidate.id === profile.baseId);
            if (parent) visit(parent);
        }
        visited.add(profile.id);
        ordered.push(profile);
        for (const child of children.get(profile.id) ?? []) visit(child);
    };
    for (const profile of profiles) if (isPromptBaseProfile(profile)) visit(profile);
    for (const profile of profiles) visit(profile);
    return JSON.stringify({
        kind: 'prompt_tree',
        formatVersion: 3,
        profiles: structuredClone(ordered),
        ...(meta.defaultSnapshot?.length ? {
            defaultSnapshot: meta.defaultSnapshot,
            defaultSnapshotLocked: meta.defaultSnapshotLocked === true,
        } : {}),
        ...(targetId ? { targetId } : {}),
    }, null, 4);
}

export function warnV1ExcludedFromTreeExport(meta: PresetMeta): void {
    if (meta.profiles.some((profile) => !isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile))) {
        toastr.warning(L('Legacy profiles are not included in the tree export'));
    }
}

export function mergeImportedProfiles(
    parsed: Record<string, any>,
    existing: PresetProfile[],
    profileName: string,
    localDefaultSnapshot?: unknown,
): { profiles: PresetProfile[]; warnings: string[] } {
    assertV3ImportPayload(parsed);
    const profiles = [...existing];
    const warnings: string[] = [];
    const usedIds = new Set(profiles.map((profile) => String(profile.id)));
    const freshId = (): string => {
        let id = newProfileId();
        while (usedIds.has(id)) id = newProfileId();
        usedIds.add(id);
        return id;
    };

    const sourceDefaultSnapshot = parsed.defaultSnapshot;

    if (parsed.kind === 'prompt_tree') {
        const targetId = typeof parsed.targetId === 'string' ? parsed.targetId : undefined;
        const imported = parsed.profiles as (PromptBaseProfile | PromptDeltaProfile)[];
        const existingIds = new Set(profiles.filter(
            (profile) => isPromptBaseProfile(profile) || isPromptDeltaProfile(profile),
        ).map((profile) => String(profile.id)));
        const prepared = prepareImportedTree(
            imported,
            profileName,
            targetId,
            freshId,
            sourceDefaultSnapshot,
            localDefaultSnapshot,
            existingIds,
        );
        profiles.push(...prepared.profiles);
        if (prepared.missingBaseIds.length > 0) {
            warnings.push(L('Base profile not found for this imported derived configuration'));
        }
        return { profiles, warnings };
    }

    if (isBaseData(parsed)) {
        const base = prepareImportedBaseProfile(parsed, sourceDefaultSnapshot, localDefaultSnapshot);
        profiles.push({ ...base, id: freshId(), name: profileName });
        return { profiles, warnings };
    }

    const delta = parsed as PromptDeltaProfile & { base?: PromptBaseProfile };
    let baseId = delta.baseId;
    if (delta.base && isBaseData(delta.base)) {
        baseId = freshId();
        const base = prepareImportedBaseProfile(delta.base, sourceDefaultSnapshot, localDefaultSnapshot);
        profiles.push({ ...base, id: baseId });
    } else if (!profiles.some((profile) => (isPromptBaseProfile(profile) || isPromptDeltaProfile(profile)) && profile.id === baseId)) {
        warnings.push(L('Base profile not found for this imported derived configuration'));
    }
    const deltaData = prepareImportedDeltaProfile(delta);
    profiles.push({ ...deltaData, id: freshId(), name: profileName, baseId });
    return { profiles, warnings };
}
