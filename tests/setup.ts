import { beforeEach } from 'vitest';
import { resetOpenaiMock } from './mocks/openai.js';

// 浏览器全局最小 stub：纯逻辑测试不触碰 DOM，但部分模块在调用路径会引用 toastr/localStorage。
globalThis.localStorage = globalThis.localStorage ?? {
    store: new Map<string, string>(),
    getItem(key: string) { return this.store.get(key) ?? null; },
    setItem(key: string, value: string) { this.store.set(key, value); },
    removeItem(key: string) { this.store.delete(key); },
    clear() { this.store.clear(); },
    key(index: number) { return [...this.store.keys()][index] ?? null; },
    get length() { return this.store.size; },
};

globalThis.toastr = globalThis.toastr ?? {
    success: () => undefined,
    info: () => undefined,
    warning: () => undefined,
    error: () => undefined,
};

globalThis.$ = globalThis.$ ?? function () {
    return {
        find: () => globalThis.$(),
        closest: () => globalThis.$(),
        on: () => globalThis.$(),
        html: () => globalThis.$(),
        val: () => '',
        text: () => globalThis.$(),
        append: () => globalThis.$(),
        addClass: () => globalThis.$(),
        removeClass: () => globalThis.$(),
        toggleClass: () => globalThis.$(),
        attr: () => '',
        data: () => undefined,
        each: () => globalThis.$(),
        filter: () => globalThis.$(),
        map: () => globalThis.$(),
        get: () => [],
        remove: () => globalThis.$(),
        trigger: () => globalThis.$(),
        toggle: () => globalThis.$(),
    };
} as never;

beforeEach(() => {
    resetOpenaiMock();
    (globalThis.localStorage as Storage).clear();
});
