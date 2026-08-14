import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { L } from '../src/i18n.js';

function setLanguage(val: string | null): void {
    if (val === null) (globalThis.localStorage as Storage).removeItem('language');
    else (globalThis.localStorage as Storage).setItem('language', val);
}

function setNavigatorLang(val: string): void {
    Object.defineProperty(globalThis, 'navigator', { value: { language: val }, configurable: true, writable: true });
}

describe('L() 语言判定', () => {
    const origNav = globalThis.navigator;

    afterEach(() => {
        Object.defineProperty(globalThis, 'navigator', { value: origNav, configurable: true, writable: true });
    });

    it('localStorage 显式 zh → 中文', () => {
        setLanguage('zh-cn');
        expect(L('Save')).toBe('保存');
    });

    it('localStorage 显式 zh-tw → 中文', () => {
        setLanguage('zh-tw');
        expect(L('Save')).toBe('保存');
    });

    it('localStorage 显式 en → 英文', () => {
        setLanguage('en');
        expect(L('Save')).toBe('Save');
    });

    it('localStorage 未设置但浏览器为 zh-CN → 中文（回退 navigator.language）', () => {
        setLanguage(null);
        setNavigatorLang('zh-CN');
        expect(L('Save')).toBe('保存');
    });

    it('localStorage 未设置且浏览器为 en → 英文', () => {
        setLanguage(null);
        setNavigatorLang('en-US');
        expect(L('Save')).toBe('Save');
    });

    it('词典无此键 → 原样返回', () => {
        setLanguage('zh-cn');
        expect(L('Some missing key here')).toBe('Some missing key here');
    });
});
