export function t(strings: TemplateStringsArray | string, ...values: unknown[]): string {
    if (Array.isArray(strings)) {
        return strings.reduce((acc, part, i) => acc + String(values[i - 1] ?? '') + part);
    }
    return String(strings);
}

export function translate(text: string, _key?: string): string {
    return text;
}

/** 与 ST 一致：localStorage['language'] || navigator.language || 'en'（小写）。 */
export function getCurrentLocale(): string {
    return String(globalThis.localStorage?.getItem('language') || globalThis.navigator?.language || 'en').toLowerCase();
}
