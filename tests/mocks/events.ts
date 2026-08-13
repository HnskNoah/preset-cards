export const event_types: Record<string, string> = {
    OAI_PRESET_CHANGED_BEFORE: 'oai-preset-changed-before',
    OAI_PRESET_CHANGED_AFTER: 'oai-preset-changed-after',
    PRESET_CHANGED: 'preset-changed',
    PRESET_DELETED: 'preset-deleted',
};

export const eventSource = {
    emit: async (_event: string, ..._args: unknown[]): Promise<boolean> => true,
};
