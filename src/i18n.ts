import { getCurrentLocale } from '@sillytavern/scripts/i18n';
import { LOCAL_DICT } from './constants.js';

export function L(text: string): string {
    const lang = getCurrentLocale().toLowerCase();
    if (lang.startsWith('zh') && LOCAL_DICT[text]) {
        return LOCAL_DICT[text];
    }
    return text;
}
