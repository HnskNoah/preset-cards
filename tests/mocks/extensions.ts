export function renderExtensionTemplateAsync(
    _extensionName: string,
    _templateId: string,
    _templateData?: Record<string, unknown>,
    _sanitize?: boolean,
    _localize?: boolean,
): Promise<string> {
    return Promise.resolve('<div></div>');
}
