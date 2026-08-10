import type {
    PromptBaseProfile,
    PromptDefaultSnapshotEntry,
    PromptDeltaChange,
    PromptDeltaProfile,
    PromptFields,
    PromptProfileEntry,
} from './meta.js';
const PROMPT_FIELD_KEYS = [
    'content',
    'name',
    'role',
    'injection_position',
    'injection_depth',
] as const;

function sanitizeFields(value: unknown): PromptFields | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const source = value as Record<string, unknown>;
    const fields: PromptFields = {};
    for (const key of PROMPT_FIELD_KEYS) {
        const fieldValue = source[key];
        const valid = key === 'injection_position' || key === 'injection_depth'
            ? typeof fieldValue === 'number'
            : typeof fieldValue === 'string';
        if (valid) (fields as Record<string, unknown>)[key] = fieldValue;
    }
    return Object.keys(fields).length > 0 ? fields : undefined;
}

function defaultFieldsById(snapshot: unknown): Map<string, PromptFields> {
    const fieldsById = new Map<string, PromptFields>();
    if (!Array.isArray(snapshot)) return fieldsById;
    for (const raw of snapshot) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as Partial<PromptDefaultSnapshotEntry>;
        if (typeof entry.identifier !== 'string') continue;
        const fields = sanitizeFields(entry.originalFields);
        if (fields) fieldsById.set(entry.identifier, fields);
    }
    return fieldsById;
}

function cloneEntry(entry: PromptProfileEntry): PromptProfileEntry {
    const fields = sanitizeFields(entry.fields);
    return {
        identifier: entry.identifier,
        mounted: entry.mounted,
        enabled: entry.enabled,
        ...(entry.lastActiveIndex !== undefined ? { lastActiveIndex: entry.lastActiveIndex } : {}),
        ...(fields ? { fields } : {}),
    };
}

export function prepareImportedBaseProfile(
    profile: PromptBaseProfile,
    sourceDefaultSnapshot?: unknown,
    localDefaultSnapshot?: unknown,
): PromptBaseProfile {
    const sourceDefaults = defaultFieldsById(sourceDefaultSnapshot);
    const localDefaults = defaultFieldsById(localDefaultSnapshot);
    const prompts = profile.prompts.map((rawEntry) => {
        const entry = cloneEntry(rawEntry);
        const sourceFields = sourceDefaults.get(entry.identifier);
        if (!sourceFields) return entry;

        const absoluteFields: PromptFields = { ...sourceFields, ...entry.fields };
        const localFields = localDefaults.get(entry.identifier);
        const rebasedFields: PromptFields = {};
        for (const key of PROMPT_FIELD_KEYS) {
            const value = absoluteFields[key];
            if (value !== undefined && value !== localFields?.[key]) {
                (rebasedFields as Record<string, unknown>)[key] = value;
            }
        }
        if (Object.keys(rebasedFields).length > 0) entry.fields = rebasedFields;
        else delete entry.fields;
        return entry;
    });

    return {
        formatVersion: 3,
        kind: 'prompt_base',
        id: profile.id,
        name: profile.name,
        prompts,
    };
}

export function prepareImportedDeltaProfile(profile: PromptDeltaProfile): PromptDeltaProfile {
    const changes: PromptDeltaChange[] = profile.changes.map((rawChange) => {
        const fields = sanitizeFields(rawChange.fields);
        return {
            identifier: rawChange.identifier,
            ...(rawChange.mounted !== undefined ? { mounted: rawChange.mounted } : {}),
            ...(rawChange.enabled !== undefined ? { enabled: rawChange.enabled } : {}),
            ...(rawChange.lastActiveIndex !== undefined ? { lastActiveIndex: rawChange.lastActiveIndex } : {}),
            ...(fields ? { fields } : {}),
        };
    });
    return {
        formatVersion: 3,
        kind: 'prompt_delta',
        id: profile.id,
        name: profile.name,
        baseId: profile.baseId,
        changes,
        ...(profile.order ? { order: [...profile.order] } : {}),
    };
}

export function prepareImportedTree(
    imported: (PromptBaseProfile | PromptDeltaProfile)[],
    profileName: string,
    targetId: string | undefined,
    freshId: () => string,
    sourceDefaultSnapshot?: unknown,
    localDefaultSnapshot?: unknown,
    existingIds: Set<string> = new Set(),
): { profiles: (PromptBaseProfile | PromptDeltaProfile)[]; missingBaseIds: string[] } {
    const idMap = new Map<string, string>();
    for (const raw of imported) idMap.set(String(raw.id), freshId());

    const missingBaseIds: string[] = [];
    const profiles = imported.map((raw, index) => {
        const id = idMap.get(String(raw.id)) as string;
        const isTarget = targetId ? String(raw.id) === targetId : index === imported.length - 1;
        if (raw.kind === 'prompt_base') {
            return {
                ...prepareImportedBaseProfile(raw, sourceDefaultSnapshot, localDefaultSnapshot),
                id,
                name: isTarget ? profileName : raw.name,
            };
        }

        const mappedBase = idMap.get(String(raw.baseId));
        if (!mappedBase && !existingIds.has(String(raw.baseId))) missingBaseIds.push(String(raw.baseId));
        return {
            ...prepareImportedDeltaProfile(raw),
            id,
            name: isTarget ? profileName : raw.name,
            baseId: mappedBase ?? raw.baseId,
        };
    });
    return { profiles, missingBaseIds };
}
