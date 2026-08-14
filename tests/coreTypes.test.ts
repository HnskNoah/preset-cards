import { describe, it, expect } from 'vitest';
import { isV3BaseProfileData, isV3DeltaProfileData } from '../src/profileSchema.js';
import { snapshotPromptState } from '../src/promptState.js';
import type { PromptBaseProfile, PromptDeltaProfile, PromptProfileEntry } from '../src/core/domain/types.js';

/**
 * Phase 1 codec 行为不变量：
 * core/domain 的领域类型必须与现有 schema 校验、纯状态函数完全兼容，
 * 这样后续把实现下沉到 core 时不会改变任何行为。
 */
describe('core/domain types compatibility', () => {
    it('base profile type passes v3 schema validation and snapshot consumption', () => {
        const profile: PromptBaseProfile = {
            formatVersion: 3,
            kind: 'prompt_base',
            id: 'b1',
            name: 'Base',
            prompts: [{ identifier: 'a', mounted: true, enabled: true }],
        };
        expect(isV3BaseProfileData(profile)).toBe(true);
        // 与 promptState 纯函数互通：core 类型可被现有快照函数消费
        const prompts = [{ identifier: 'a', enabled: true }];
        const order = [{ identifier: 'a', enabled: true }];
        const snapshot = snapshotPromptState(prompts, order);
        expect(snapshot.entries).toHaveLength(1);
        expect((snapshot.entries[0] as PromptProfileEntry).identifier).toBe('a');
    });

    it('delta profile type passes v3 schema validation', () => {
        const profile: PromptDeltaProfile = {
            formatVersion: 3,
            kind: 'prompt_delta',
            id: 'd1',
            name: 'Delta',
            baseId: 'b1',
            changes: [{ identifier: 'a', enabled: false }],
        };
        expect(isV3DeltaProfileData(profile)).toBe(true);
    });
});
