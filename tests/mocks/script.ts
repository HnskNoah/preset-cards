export function getRequestHeaders(_options?: { omitContentType?: boolean }): Record<string, string> {
    return { 'Content-Type': 'application/json' };
}

export function saveSettingsDebounced(_loopCounter?: number): void {
    // no-op
}
