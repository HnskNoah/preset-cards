// 回归测试：profile 编辑器提交基线 = profile 解析态（唯一基线语义）。
// 背景：注册投影流下父预设 prompt_order 与 profile 解析态脱节，旧实现以父预设 order
// 为提交快照来源，commit 会把父预设旧状态写进 profile（开关翻转/挂载丢失/delta 差异蒸发/模型盖入）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openai_settings, oai_settings, addPreset } from './mocks/openai.js';
import { EXTENSION_KEY } from '../src/constants.js';
import { bufferKey } from '../src/presetBuffers.js';
import { createEditorContext, type EditorContext } from '../src/profileEditorContext.js';
import {
    applyBufferedAndSnapshot,
} from '../src/profileEditorState.js';
import { effectiveFieldsFor, resolveBaselineEntries, seedPresetDriftIntoBuffers } from '../src/profileEditorBaseline.js';
import { mergeBaseSnapshot } from '../src/presetSnapshot.js';
import { snapshotToChanges, resolveParentStates, findPromptInPreset } from '../src/promptToggle.js';
import { applyPromptDelta } from '../src/promptState.js';
import { commitUpdate, commitCreateDelta } from '../src/profileEditorState.js';
import { stagedItems } from '../src/profileEditorStaged.js';
import { setActiveProfile } from '../src/activeProfile.js';
import { readMeta } from '../src/meta.js';
import type { Preset, PromptFields } from '../src/meta.js';

function parentPreset(): Record<string, any> {
    return {
        prompts: ['p1', 'p2', 'p3', 'p4'].map((id, i) => ({
            identifier: id,
            name: `P${i + 1}`,
            content: `c${i + 1}`,
            role: 'system',
            marker: false,
            system_prompt: false,
            enabled: true,
            injection_position: 0,
            injection_depth: 0,
        })),
        // 父预设实时 order：p4 不在 order。注册投影流下这份 order 长期不随 profile 应用而变。
        prompt_order: [
            {
                character_id: 100001,
                order: [
                    { identifier: 'p1', enabled: true },
                    { identifier: 'p2', enabled: true },
                    { identifier: 'p3', enabled: true },
                ],
            },
        ],
    };
}

const B = {
    kind: 'prompt_base',
    formatVersion: 3,
    id: 'b1',
    name: 'B',
    prompts: [
        { identifier: 'p1', mounted: true, enabled: true },
        { identifier: 'p2', mounted: true, enabled: false },
        { identifier: 'p3', mounted: true, enabled: true },
        { identifier: 'p4', mounted: true, enabled: true },
    ],
} as any;

const B2 = {
    kind: 'prompt_base',
    formatVersion: 3,
    id: 'b2',
    name: 'B2',
    prompts: [
        { identifier: 'p1', mounted: true, enabled: true },
        { identifier: 'p2', mounted: true, enabled: true },
        { identifier: 'p3', mounted: true, enabled: true },
        { identifier: 'p4', mounted: true, enabled: true },
    ],
} as any;

const D = {
    kind: 'prompt_delta',
    formatVersion: 3,
    id: 'd1',
    name: 'D',
    baseId: 'b2',
    changes: [{ identifier: 'p2', enabled: false }],
} as any;

function installPreset(profiles: any[], presetOverrides?: Record<string, any>): Preset {
    const preset = parentPreset() as Preset;
    Object.assign(preset, presetOverrides ?? {});
    preset.extensions = { [EXTENSION_KEY]: { description: '', models: [], bgImage: '', profiles } };
    addPreset('P', preset);
    oai_settings.preset_settings_openai = 'P';
    return preset;
}

function makeCtx(profileId: string): EditorContext {
    return createEditorContext(
        {
            sessionEdits: new Map(),
            pendingToggles: new Map(),
            refreshActivePresetUI: () => {},
            onGridRefresh: async () => {},
        },
        'P',
        0,
        profileId,
    );
}

/** 与 profileEditorHandlers 提交路径一致：有效值字段表（出厂 ⊕ profile 解析）。 */
function buildEffectiveMap(preset: Preset, ctx: EditorContext): Map<string, PromptFields> {
    const meta = readMeta(preset);
    const map = new Map<string, PromptFields>();
    for (const entry of resolveBaselineEntries(ctx)) {
        map.set(entry.identifier, effectiveFieldsFor(meta, entry, findPromptInPreset(preset, entry.identifier)));
    }
    return map;
}

/** 模拟用户在编辑器里的唯一操作：把 p3 开关关掉。 */
function toggleP3Off(ctx: EditorContext): void {
    ctx.pendingToggles.set(bufferKey('P', 'p3'), false);
    const so = ctx.sessionOrder.find((o) => o.identifier === 'p3');
    if (so) so.enabled = false;
}

function commitSnapshot(preset: Preset, ctx: EditorContext) {
    return applyBufferedAndSnapshot(
        preset,
        'P',
        ctx.sessionEdits,
        ctx.pendingToggles,
        ctx.pendingClears,
        ctx.sessionOrder,
        buildEffectiveMap(preset, ctx),
    );
}

describe('编辑器提交基线 = profile 解析态', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true } as Response)));
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('注册流（父预设 order 脱节）：base 更新保留未编辑条目的开关与挂载', () => {
        const preset = installPreset([B]);
        const ctx = makeCtx('b1');
        // sessionOrder 种子 = profile 解析态：p2 关、p4 挂载（而非父预设的 p2 开、p4 缺失）
        expect(ctx.sessionOrder.find((o) => o.identifier === 'p2')?.enabled).toBe(false);
        expect(ctx.sessionOrder.some((o) => o.identifier === 'p4')).toBe(true);

        toggleP3Off(ctx);
        const merged = structuredClone(B);
        mergeBaseSnapshot(merged, commitSnapshot(preset, ctx), 'P', ctx.sessionEdits);

        const byId = new Map(merged.prompts.map((p: any) => [p.identifier, p]));
        expect(byId.get('p3')?.enabled).toBe(false); // 用户编辑生效
        expect(byId.get('p2')?.enabled).toBe(false); // 未编辑条目保持 profile 原值（不被父预设翻转）
        expect(byId.get('p1')?.enabled).toBe(true);
        expect(byId.has('p4')).toBe(true); // profile 挂载的 p4 不被丢进 unusedIds
        expect(merged.unusedIds ?? []).not.toContain('p4');
    });

    it('注册流：父预设 order 中 profile 未引用的条目不会被挂载进 profile', () => {
        const preset = installPreset([B]);
        (preset.prompts as any[]).push({
            identifier: 'p5', name: 'P5', content: 'c5', role: 'system',
            marker: false, system_prompt: false, enabled: true,
        });
        ((preset.prompt_order as any[])[0].order as any[]).push({ identifier: 'p5', enabled: true });

        const ctx = makeCtx('b1');
        toggleP3Off(ctx);
        const merged = structuredClone(B);
        mergeBaseSnapshot(merged, commitSnapshot(preset, ctx), 'P', ctx.sessionEdits);

        expect(merged.prompts.some((p: any) => p.identifier === 'p5')).toBe(false);
    });

    it('注册流：delta 更新保留自身持久差异 {p2:关}，不产生凭空的 {p4:卸载}', () => {
        installPreset([B2, D]);
        const ctx = makeCtx('d1');
        toggleP3Off(ctx);

        const preset = openai_settings[0] as Preset;
        const snapshot = commitSnapshot(preset, ctx);
        const parentEntries = resolveParentStates(D, [B2, D]);
        const changes = snapshotToChanges(snapshot.entries, parentEntries, D.changes, snapshot.unusedIds);

        const p2Change = changes.find((c) => c.identifier === 'p2');
        expect(p2Change?.enabled).toBe(false); // D 的存在意义不被父预设旧状态抹掉
        const p3Change = changes.find((c) => c.identifier === 'p3');
        expect(p3Change?.enabled).toBe(false); // 用户编辑生效
        expect(changes.find((c) => c.identifier === 'p4')).toBeUndefined(); // 无凭空卸载

        const applied = applyPromptDelta(parentEntries, changes);
        expect(applied.find((e) => e.identifier === 'p2')?.enabled).toBe(false);
        expect(applied.find((e) => e.identifier === 'p4')?.mounted).toBe(true);
    });

    it('字段级流（预设状态与 profile 一致）：提交结果与注册流一致，仅用户编辑生效', () => {
        // 预设 order = profile 解析态（字段级应用后的正常形态）
        const preset = installPreset([B]);
        (preset.prompt_order as any[])[0].order = [
            { identifier: 'p1', enabled: true },
            { identifier: 'p2', enabled: false },
            { identifier: 'p3', enabled: true },
            { identifier: 'p4', enabled: true },
        ];

        const ctx = makeCtx('b1');
        toggleP3Off(ctx);
        const merged = structuredClone(B);
        mergeBaseSnapshot(merged, commitSnapshot(preset, ctx), 'P', ctx.sessionEdits);

        const byId = new Map(merged.prompts.map((p: any) => [p.identifier, p]));
        expect(byId.get('p3')?.enabled).toBe(false);
        expect(byId.get('p2')?.enabled).toBe(false);
        expect(byId.has('p4')).toBe(true);
    });

    it('值编辑净零（改了又改回基线值）不抹掉 profile 既有 fields 差异', () => {
        const withFields = {
            ...B,
            prompts: B.prompts.map((p: any) => (p.identifier === 'p1' ? { ...p, fields: { content: 'X' } } : p)),
        };
        const preset = installPreset([withFields]);
        const ctx = makeCtx('b1');
        // 模拟一次「改了又改回」的会话缓冲：initial == edited（净零）
        const effective = buildEffectiveMap(preset, ctx).get('p1')!;
        ctx.sessionEdits.set(bufferKey('P', 'p1'), { initial: effective, edited: { ...effective } });

        const merged = structuredClone(withFields);
        mergeBaseSnapshot(merged, commitSnapshot(preset, ctx), 'P', ctx.sessionEdits);
        expect(merged.prompts.find((p: any) => p.identifier === 'p1')?.fields?.content).toBe('X');
    });

    it('编辑表单预填基线 = 有效值字段（出厂 ⊕ 解析 fields），非父预设定义', () => {
        const withFields = {
            ...B,
            prompts: B.prompts.map((p: any) => (p.identifier === 'p1' ? { ...p, fields: { content: 'X' } } : p)),
        };
        const preset = installPreset([withFields]);
        // 父预设定义 content 是 c1，profile 解析值是 X：预填必须取 X
        const ctx = makeCtx('b1');
        const effective = buildEffectiveMap(preset, ctx).get('p1')!;
        expect(effective.content).toBe('X');
    });
});

describe('提交写回与顶层采集按运行时归属分流', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true } as Response)));
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    async function commitWithFakeTimers(p: Promise<unknown>): Promise<void> {
        vi.useFakeTimers();
        await vi.advanceTimersByTimeAsync(400);
        await p;
        vi.useRealTimers();
    }

    it('注册流：commitUpdate 不采集父预设模型、不写回父预设本体', async () => {
        const preset = installPreset([B], { chat_completion_source: 'openai', openai_model: 'gpt-parent' });
        const ctx = makeCtx('b1');
        toggleP3Off(ctx);
        // 活动预设 = 注册投影（非父预设）
        oai_settings.preset_settings_openai = 'P - B';

        const snapshot = commitSnapshot(preset, ctx);
        const orderBefore = JSON.stringify(preset.prompt_order);
        await commitWithFakeTimers(commitUpdate(ctx, snapshot, { captureTopLevel: false }));

        const saved = (preset.extensions as any)[EXTENSION_KEY].profiles[0];
        expect(saved.model).toBeUndefined(); // 编辑器没有模型 UI，父预设模型不得盖入
        expect(JSON.stringify(preset.prompt_order)).toBe(orderBefore); // 不写回父预设 order
    });

    it('字段级流：commitUpdate 保留模型采集并写回父预设 order', async () => {
        const preset = installPreset([B], { chat_completion_source: 'openai', openai_model: 'gpt-parent' });
        const ctx = makeCtx('b1');
        toggleP3Off(ctx);
        // 活动预设 = 父预设本身（字段级应用态）
        oai_settings.preset_settings_openai = 'P';

        const snapshot = commitSnapshot(preset, ctx);
        await commitWithFakeTimers(commitUpdate(ctx, snapshot, { captureTopLevel: true }));

        const saved = (preset.extensions as any)[EXTENSION_KEY].profiles[0];
        expect(saved.model).toEqual({ source: 'openai', name: 'gpt-parent' });
        // 写回：sessionOrder（含 p3 关）投影回父预设目标 order
        const order = (preset.prompt_order as any[])[0].order;
        expect(order.find((o: any) => o.identifier === 'p3')?.enabled).toBe(false);
    });

    it('注册流：commitCreateDelta 继承父链，不采集父预设采样/模型', async () => {
        const preset = installPreset([B2], {
            chat_completion_source: 'openai',
            openai_model: 'gpt-parent',
            temperature: 0.7,
        });
        const ctx = makeCtx('b2');
        toggleP3Off(ctx);
        oai_settings.preset_settings_openai = 'P - B2';

        const snapshot = commitSnapshot(preset, ctx);
        await commitWithFakeTimers(commitCreateDelta(ctx, 'New', snapshot, { captureTopLevel: false }));

        const profiles = (preset.extensions as any)[EXTENSION_KEY].profiles;
        const delta = profiles.find((p: any) => p.name === 'New');
        expect(delta).toBeDefined();
        expect(delta.sampling).toBeUndefined();
        expect(delta.model).toBeUndefined();
        expect(delta.extra).toBeUndefined();
    });

    it('字段级流：commitCreateDelta 保留父预设采样/模型采集（既有特性）', async () => {
        const preset = installPreset([B2], {
            chat_completion_source: 'openai',
            openai_model: 'gpt-parent',
            temperature: 0.7,
        });
        const ctx = makeCtx('b2');
        toggleP3Off(ctx);
        oai_settings.preset_settings_openai = 'P';

        const snapshot = commitSnapshot(preset, ctx);
        await commitWithFakeTimers(commitCreateDelta(ctx, 'New', snapshot, { captureTopLevel: true }));

        const profiles = (preset.extensions as any)[EXTENSION_KEY].profiles;
        const delta = profiles.find((p: any) => p.name === 'New');
        expect(delta.sampling).toMatchObject({ temperature: 0.7 });
        expect(delta.model).toEqual({ source: 'openai', name: 'gpt-parent' });
    });
});

describe('漂移种子化（字段级流的原生编辑预填为 staged 项）', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true } as Response)));
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('字段级流：开关/挂载/顺序/值漂移全部预填进会话缓冲', () => {
        // 预设现状（原生 PM 漂移后）：p2 开（profile 是关）、p4 被摘除、p1/p2 换序、p1 内容被改
        const preset = installPreset([B]);
        (preset.prompts as any[])[0].content = 'drifted';
        (preset.prompt_order as any[])[0].order = [
            { identifier: 'p2', enabled: true },
            { identifier: 'p1', enabled: true },
            { identifier: 'p3', enabled: true },
        ];
        // 出厂基线（defaultSnapshot 存在时有效基线 = 出厂值 ⊕ 解析 fields，才能检出定义层漂移）
        (preset.extensions as any)[EXTENSION_KEY].defaultSnapshot = [
            {
                identifier: 'p1', mounted: true, enabled: true,
                originalFields: { content: 'c1', name: 'P1', role: 'system', injection_position: 0, injection_depth: 0 },
            },
        ];
        setActiveProfile({ presetName: 'P', profileId: 'b1' });

        const ctx = makeCtx('b1');
        seedPresetDriftIntoBuffers(ctx);

        // 开关漂移：p2 预填为预设真值「开」
        expect(ctx.pendingToggles.get(bufferKey('P', 'p2'))).toBe(true);
        expect(ctx.sessionOrder.find((o) => o.identifier === 'p2')?.enabled).toBe(true);
        // 挂载漂移：p4 预填卸载（记录解析原位供 undo）
        expect(ctx.pendingMounts.get(bufferKey('P', 'p4'))).toBe(false);
        expect(ctx.sessionOrder.some((o) => o.identifier === 'p4')).toBe(false);
        // 顺序漂移：p1/p2 换序
        expect(ctx.reorderedIds.has('p1')).toBe(true);
        expect(ctx.reorderedIds.has('p2')).toBe(true);
        // 值漂移：p1 内容预填为预设值
        const session = ctx.sessionEdits.get(bufferKey('P', 'p1'));
        expect(session?.edited.content).toBe('drifted');
        // staged 面板可见
        expect(stagedItems(ctx).length).toBeGreaterThan(0);
    });

    it('注册投影流：不种子（父预设状态与本 profile 无关）', () => {
        const preset = installPreset([B]);
        (preset.prompt_order as any[])[0].order = [
            { identifier: 'p2', enabled: true },
            { identifier: 'p1', enabled: true },
            { identifier: 'p3', enabled: true },
        ];
        setActiveProfile({ presetName: 'P', profileId: 'b1' });
        oai_settings.preset_settings_openai = 'P - B'; // 活动预设是投影

        const ctx = makeCtx('b1');
        seedPresetDriftIntoBuffers(ctx);

        expect(ctx.pendingToggles.size).toBe(0);
        expect(ctx.pendingMounts.size).toBe(0);
        expect(ctx.sessionEdits.size).toBe(0);
        expect(stagedItems(ctx).length).toBe(0);
    });

    it('种子后的 commit 把漂移折叠进 profile（端到端）', async () => {
        const preset = installPreset([B]);
        (preset.prompt_order as any[])[0].order = [
            { identifier: 'p1', enabled: true },
            { identifier: 'p2', enabled: true },
            { identifier: 'p3', enabled: true },
        ];
        setActiveProfile({ presetName: 'P', profileId: 'b1' });

        const ctx = makeCtx('b1');
        seedPresetDriftIntoBuffers(ctx);
        expect(ctx.pendingToggles.get(bufferKey('P', 'p2'))).toBe(true); // 漂移：p2 被原生打开

        const snapshot = applyBufferedAndSnapshot(
            preset, 'P', ctx.sessionEdits, ctx.pendingToggles, ctx.pendingClears, ctx.sessionOrder,
            buildEffectiveMap(preset, ctx),
        );
        vi.useFakeTimers();
        const committing = commitUpdate(ctx, snapshot, { captureTopLevel: false });
        await vi.advanceTimersByTimeAsync(400);
        const ok = await committing;
        vi.useRealTimers();
        expect(ok).toBe(true);

        const merged = (preset.extensions as any)[EXTENSION_KEY].profiles[0];
        const byId = new Map(merged.prompts.map((p: any) => [p.identifier, p]));
        expect(byId.get('p2')?.enabled).toBe(true); // 漂移折叠：p2 开进 profile
        expect(byId.get('p3')?.enabled).toBe(true); // 未漂移条目不受影响
        // 卸载漂移折叠：p4 从挂载集移除（进 unusedIds）
        expect(byId.has('p4')).toBe(false);
        expect(merged.unusedIds).toContain('p4');
    });
});
