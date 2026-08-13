import { describe, it, expect } from 'vitest';
import { resolveProfileMountedMap } from '../src/profileEditorState.js';

const base = (id: string, prompts: any[]): any => ({ formatVersion: 3, kind: 'prompt_base', id, name: 'Base', prompts });
const delta = (id: string, baseId: string, changes: any[]): any => ({ formatVersion: 3, kind: 'prompt_delta', id, name: 'Delta', baseId, changes });

describe('resolveProfileMountedMap', () => {
    it('reflects profile-resolved mount state (base + delta overlay)', () => {
        const b = base('b1', [
            { identifier: 'a', mounted: true, enabled: true },
            { identifier: 'u', mounted: false, enabled: false },
        ]);
        const d = delta('d1', 'b1', [{ identifier: 'u', mounted: true }]);
        const map = resolveProfileMountedMap({ profile: d, meta: { profiles: [b, d] } } as any);
        expect(map.get('a')).toBe(true);
        expect(map.get('u')).toBe(true);
    });

    it('marks entries unknown to the profile as absent', () => {
        const b = base('b1', [{ identifier: 'a', mounted: true, enabled: true }]);
        const d = delta('d1', 'b1', []);
        const map = resolveProfileMountedMap({ profile: d, meta: { profiles: [b, d] } } as any);
        expect(map.has('unknown-entry')).toBe(false);
    });
});
