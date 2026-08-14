import { describe, it, expect } from 'vitest';
import { isRepeatedRunName } from '../src/presetList.js';

describe('isRepeatedRunName', () => {
    it('普通名字不视为重复串', () => {
        expect(isRepeatedRunName('My Preset')).toBe(false);
        expect(isRepeatedRunName('Claude 3.5 Sonnet')).toBe(false);
        expect(isRepeatedRunName('长预设名称测试')).toBe(false);
        expect(isRepeatedRunName('')).toBe(false);
    });

    it('≥12 个相同字符连续重复视为重复串（忽略空白）', () => {
        expect(isRepeatedRunName('aaaaaaaaaaaa')).toBe(true);
        expect(isRepeatedRunName('a a a a a a a a a a a a')).toBe(true);
        expect(isRepeatedRunName('!!!!!!!!!!!!')).toBe(true);
        expect(isRepeatedRunName('------------')).toBe(true);
    });

    it('不足 12 个重复字符不视为重复串', () => {
        expect(isRepeatedRunName('aaaaaaaaaa')).toBe(false);
        expect(isRepeatedRunName('!!!!!!')).toBe(false);
    });

    it('重复字符夹杂其他内容，达到阈值仍视为重复串', () => {
        expect(isRepeatedRunName('prefix aaaaaaaaaaaa suffix')).toBe(true);
    });
});
