export function t(strings: TemplateStringsArray | string, ...values: unknown[]): string {
    if (Array.isArray(strings)) {
        return strings.reduce((acc, part, i) => acc + String(values[i - 1] ?? '') + part);
    }
    return String(strings);
}
