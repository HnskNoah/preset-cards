#!/usr/bin/env node
/**
 * preset-cards v1/v2 → v3 迁移工具
 *
 * 将旧版 profile 导出文件转换为 v3 格式，供新版 preset-cards 插件导入。
 *
 * 用法：
 *   npx tsx tools/migrate-to-v3.ts input.json               # 输出 input.v3.json
 *   npx tsx tools/migrate-to-v3.ts input.json -o output.json # 指定输出路径
 *   npx tsx tools/migrate-to-v3.ts --dir ./backup            # 批量转换目录下所有 .json
 *
 * 支持输入格式：
 *   - v1 全量预设快照（`PresetProfileV1`，含 settings 字段）
 *   - v2 base/delta profile（`formatVersion: 2`）
 *   - v3 prompt_tree 文件（`kind: "prompt_tree"`，升级内部 v2 条目）
 *   - 纯 preset 导出（预设本体 JSON，含 prompts 数组）
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

// ── 类型定义 ──

interface PromptFields {
    content?: string;
    name?: string;
    role?: string;
    injection_position?: number;
    injection_depth?: number;
}

interface PromptSampling {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    top_a?: number;
    min_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    repetition_penalty?: number;
    seed?: number;
    n?: number;
    openai_max_context?: number;
    openai_max_tokens?: number;
    stream_openai?: boolean;
}

interface PromptProfileEntry {
    identifier: string;
    mounted: boolean;
    enabled: boolean;
    lastActiveIndex?: number;
    fields?: PromptFields;
}

interface PromptBaseProfile {
    formatVersion: 3;
    kind: 'prompt_base';
    id: string;
    name: string;
    prompts: PromptProfileEntry[];
    unusedIds?: string[];
    archive?: true;
    sampling?: PromptSampling;
    extra?: Record<string, any>;
}

interface PromptDeltaChange {
    identifier: string;
    mounted?: boolean;
    enabled?: boolean;
    lastActiveIndex?: number;
    fields?: Record<string, any>;
}

interface PromptDeltaProfile {
    formatVersion: 3;
    kind: 'prompt_delta';
    id: string;
    name: string;
    baseId: string;
    changes: PromptDeltaChange[];
    order?: string[];
    sampling?: PromptSampling;
    extra?: Record<string, any>;
}

interface PresetProfileV1 {
    id: string;
    name: string;
    settings: Record<string, any>;
    formatVersion?: 1;
}

type PresetProfile = PresetProfileV1 | PromptBaseProfile | PromptDeltaProfile;

// ── 常量 ──

const PROMPT_FIELD_KEYS = [
    'content', 'name', 'role', 'injection_position', 'injection_depth',
] as const;

const SAMPLING_KEYS = [
    'temperature', 'top_p', 'top_k', 'top_a', 'min_p',
    'frequency_penalty', 'presence_penalty', 'repetition_penalty',
    'seed', 'n', 'openai_max_context', 'openai_max_tokens', 'stream_openai',
] as const;

/** 随 profile 快照排除的 third-party 自管理 prompt identifier */
const PROMPT_NEVER_CAPTURE = new Set<string>(['SPresetSettings']);

/** 已知的 ST 连接键（settingsToUpdate 中标记 is_connection=true 的字段），
 * 排除出 extra 快照（它们是用户当前连接状态，不是 profile 配置内容）。 */
const KNOWN_CONNECTION_KEYS = new Set([
    'chat_completion_source', 'stream_openai', 'openai_model', 'claude_model',
    'openrouter_model', 'ai21_model', 'google_model', 'vertexai_model',
    'mistralai_model', 'custom_model', 'cohere_model', 'perplexity_model',
    'groq_model', 'electronhub_model', 'chutes_model', 'nanogpt_model',
    'deepseek_model', 'aimlapi_model', 'xai_model', 'pollinations_model',
    'moonshot_model', 'fireworks_model', 'cometapi_model', 'azure_openai_model',
    'zai_model', 'siliconflow_model', 'workers_ai_model', 'minimax_model',
    'reverse_proxy', 'proxy_password', 'custom_url', 'openrouter_use_fallback',
    'openrouter_providers', 'openrouter_quantizations',
]);

const EXTRA_EXCLUDED_KEYS = new Set([
    'prompts', 'prompt_order', 'extensions', 'name',
    ...KNOWN_CONNECTION_KEYS,
]);

// ── 纯函数（从插件源码内联，无 ST 依赖） ──

function newProfileId(): string {
    return Date.now().toString() + Math.floor(Math.random() * 1000);
}

function isNeverCaptureIdentifier(identifier: string): boolean {
    return PROMPT_NEVER_CAPTURE.has(identifier);
}

function capturePromptFields(prompt: Record<string, any> | undefined): PromptFields {
    const fields: PromptFields = {};
    if (!prompt) return fields;
    for (const key of PROMPT_FIELD_KEYS) {
        const value = prompt[key];
        if (value !== undefined) {
            (fields as Record<string, any>)[key] = value;
        }
    }
    return fields;
}

function filterFields(fields: Record<string, any> | undefined): PromptFields {
    const out: PromptFields = {};
    if (!fields) return out;
    for (const key of PROMPT_FIELD_KEYS) {
        if (fields[key] !== undefined) (out as Record<string, any>)[key] = fields[key];
    }
    return out;
}

function captureExtra(settings: Record<string, unknown>): Record<string, any> | null {
    const extra: Record<string, any> = {};
    for (const [key, value] of Object.entries(settings)) {
        if (SAMPLING_KEYS.some((k) => k === key)) continue;
        if (EXTRA_EXCLUDED_KEYS.has(key)) continue;
        extra[key] = value;
    }
    return Object.keys(extra).length > 0 ? extra : null;
}

function snapshotPromptState(
    prompts: { identifier: string; enabled?: boolean }[],
    order: { identifier: string; enabled?: boolean }[],
): { entries: PromptProfileEntry[]; unusedIds: string[] } {
    const promptById = new Map(prompts.map((p) => [p.identifier, p]));
    const mounted = new Set<string>();
    const entries: PromptProfileEntry[] = [];
    const orderIdx = new Map(order.map((o, i) => [o.identifier, i]));
    for (const orderEntry of order) {
        if (!orderEntry || isNeverCaptureIdentifier(orderEntry.identifier)) continue;
        const prompt = promptById.get(orderEntry.identifier);
        if (!prompt || mounted.has(orderEntry.identifier)) continue;
        mounted.add(orderEntry.identifier);
        entries.push({
            identifier: orderEntry.identifier,
            mounted: true,
            enabled: orderEntry.enabled ?? prompt.enabled ?? true,
            lastActiveIndex: orderIdx.get(orderEntry.identifier) ?? entries.length,
        });
    }
    const unusedIds = prompts
        .filter((p) => p.identifier && !isNeverCaptureIdentifier(p.identifier) && !mounted.has(p.identifier))
        .map((p) => p.identifier);
    return { entries, unusedIds };
}

function makeBaseProfile(p: {
    id: string;
    name: string;
    prompts: PromptProfileEntry[];
    unusedIds?: string[];
    sampling?: PromptSampling;
    extra?: Record<string, any>;
    archive?: true;
}): PromptBaseProfile {
    return {
        formatVersion: 3,
        kind: 'prompt_base',
        id: p.id,
        name: p.name,
        prompts: p.prompts,
        ...(p.unusedIds ? { unusedIds: p.unusedIds } : {}),
        ...(p.sampling ? { sampling: p.sampling } : {}),
        ...(p.extra ? { extra: p.extra } : {}),
        ...(p.archive ? { archive: true } : {}),
    };
}

function makeDeltaProfile(p: {
    id: string;
    name: string;
    baseId: string;
    changes: PromptDeltaChange[];
    order?: string[];
    sampling?: PromptSampling;
    extra?: Record<string, any>;
}): PromptDeltaProfile {
    return {
        formatVersion: 3,
        kind: 'prompt_delta',
        id: p.id,
        name: p.name,
        baseId: p.baseId,
        changes: p.changes,
        ...(p.order ? { order: p.order } : {}),
        ...(p.sampling ? { sampling: p.sampling } : {}),
        ...(p.extra ? { extra: p.extra } : {}),
    };
}

/** v1 全量预设快照 → v3 base profile */
function convertV1ToBase(v1: PresetProfileV1, opts?: { archive?: boolean }): PromptBaseProfile {
    const settings = v1.settings;
    const prompts = Array.isArray(settings.prompts)
        ? settings.prompts.filter((p: any) => p && typeof p.identifier === 'string' && p.identifier)
        : [];
    const order = Array.isArray(settings.prompt_order)
        ? settings.prompt_order.find((l: any) => l && String(l.character_id) === '100001')?.order ?? []
        : [];
    let { entries, unusedIds } = snapshotPromptState(prompts, Array.isArray(order) ? order : []);
    entries = entries.map((e) => {
        const prompt = prompts.find((p: any) => p.identifier === e.identifier);
        const fields = capturePromptFields(prompt);
        if (Object.keys(fields).length > 0) e.fields = fields;
        return e;
    });
    const sampling: PromptSampling = {};
    for (const key of SAMPLING_KEYS) {
        const value = (settings as Record<string, unknown>)[key];
        if (value !== undefined) (sampling as Record<string, unknown>)[key] = value;
    }
    const extra = captureExtra(settings as Record<string, unknown>);
    const jb = (settings as Record<string, unknown>)['jailbreak'];
    if (typeof jb === 'string' && jb.length > 0) {
        const jbEntry = entries.find((e) => e.identifier === 'jailbreak');
        if (jbEntry) {
            jbEntry.fields = { ...(jbEntry.fields ?? {}), content: jb };
            if (extra) delete extra['jailbreak'];
        }
    }
    return makeBaseProfile({
        id: v1.id || newProfileId(),
        name: v1.name,
        prompts: entries,
        ...(unusedIds.length > 0 ? { unusedIds } : {}),
        ...(opts?.archive ? { archive: true } : {}),
        ...(Object.keys(sampling).length > 0 ? { sampling } : {}),
        ...(extra ? { extra } : {}),
    });
}

/** 从 v1 构造隐藏只读 archive base */
function buildArchiveBase(v1: PresetProfileV1): PromptBaseProfile {
    return convertV1ToBase(v1, { archive: true });
}

/** v2 base → v3 base */
function migrateV2Base(raw: Record<string, any>): PromptBaseProfile {
    return {
        formatVersion: 3,
        kind: 'prompt_base',
        id: raw.id,
        name: raw.name,
        prompts: raw.prompts.map((entry: any, i: number) => ({
            identifier: entry.identifier,
            mounted: true,
            enabled: entry.enabled,
            ...(i > 0 || raw.prompts.length > 1 ? { lastActiveIndex: i } : {}),
            ...(entry.fields ? { fields: { ...entry.fields } } : {}),
        })),
        ...(raw.sampling ? { sampling: raw.sampling } : {}),
        ...(raw.extra ? { extra: raw.extra } : {}),
    };
}

/** v2 delta → v3 delta */
function migrateV2Delta(raw: Record<string, any>): PromptDeltaProfile {
    return {
        formatVersion: 3,
        kind: 'prompt_delta',
        id: raw.id,
        name: raw.name,
        baseId: raw.baseId,
        changes: raw.changes as PromptDeltaChange[],
        ...(raw.sampling ? { sampling: raw.sampling } : {}),
        ...(raw.extra ? { extra: raw.extra } : {}),
    };
}

/** 检测文件格式并迁移 */
export function migrateFile(input: Record<string, any>): Record<string, any> {
    // v1 格式：有 settings 字段且无 kind → 全量预设快照
    if (input.settings && input.kind === undefined && Array.isArray(input.settings.prompts)) {
        const profile = input as PresetProfileV1;
        const archive = buildArchiveBase(profile);
        const visible = makeDeltaProfile({ id: newProfileId(), name: profile.name, baseId: archive.id, changes: [] });
        return {
            kind: 'prompt_tree',
            formatVersion: 3,
            profiles: [archive, visible],
            info: `Migrated from v1 preset snapshot "${profile.name}" (id: ${profile.id})`,
        };
    }

    // prompt_tree 文件（优先于 v3 格式检查，因为可能含 v2 内部条目）
    if (input.kind === 'prompt_tree' && Array.isArray(input.profiles)) {
        const migrated = input.profiles.map((p: any) => {
            if (p.kind === 'prompt_base' && p.formatVersion === 2) return migrateV2Base(p);
            if (p.kind === 'prompt_delta' && p.formatVersion === 2) return migrateV2Delta(p);
            return p;
        });
        return { ...input, profiles: migrated };
    }

    // v2 base
    if (input.kind === 'prompt_base' && input.formatVersion === 2) {
        return migrateV2Base(input);
    }

    // v2 delta
    if (input.kind === 'prompt_delta' && input.formatVersion === 2) {
        return migrateV2Delta(input);
    }

    // v3 格式：无需迁移
    if (input.formatVersion === 3) {
        return input;
    }

    // 纯预设本体（有 prompts 数组，无 profile 包装）
    if (Array.isArray(input.prompts)) {
        // 尝试提取 global order
        const order = Array.isArray(input.prompt_order)
            ? input.prompt_order.find((l: any) => l && String(l.character_id) === '100001')?.order ?? []
            : [];
        const { entries, unusedIds } = snapshotPromptState(
            input.prompts.filter((p: any) => p && p.identifier),
            Array.isArray(order) ? order : [],
        );
        const sampling: PromptSampling = {};
        for (const key of SAMPLING_KEYS) {
            const value = (input as Record<string, unknown>)[key];
            if (value !== undefined) (sampling as Record<string, unknown>)[key] = value;
        }
        const extra = captureExtra(input as Record<string, unknown>);
        return makeBaseProfile({
            id: newProfileId(),
            name: input.name || 'Migrated Preset',
            prompts: entries,
            ...(unusedIds.length > 0 ? { unusedIds } : {}),
            ...(Object.keys(sampling).length > 0 ? { sampling } : {}),
            ...(extra ? { extra } : {}),
        });
    }

    throw new Error(`Unrecognized format: cannot determine input type from ${JSON.stringify(input).slice(0, 200)}`);
}

// ── CLI 入口 ──

function printUsage(): void {
    console.log(`
Usage:
  npx tsx tools/migrate-to-v3.ts input.json [-o output.json]
  npx tsx tools/migrate-to-v3.ts --dir <directory>   # batch convert all .json files

Options:
  -o, --output   Output file path (default: input.v3.json)
  --dir          Batch convert all .json files in directory
  --dry-run      Show what would be converted without writing
  -h, --help     Show this help
`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
        printUsage();
        process.exit(0);
    }

    const dryRun = args.includes('--dry-run');

    if (args.includes('--dir')) {
        const dirIndex = args.indexOf('--dir') + 1;
        if (dirIndex >= args.length) {
            console.error('Error: --dir requires a directory path');
            process.exit(1);
        }
        const dir = path.resolve(args[dirIndex]);
        if (!fs.existsSync(dir)) {
            console.error(`Error: directory not found: ${dir}`);
            process.exit(1);
        }
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
        if (files.length === 0) {
            console.log(`No .json files found in ${dir}`);
            process.exit(0);
        }
        console.log(`Found ${files.length} .json files in ${dir}`);
        for (const file of files) {
            const inputPath = path.join(dir, file);
            const outputPath = path.join(dir, file.replace(/\.json$/, '.v3.json'));
            await processFile(inputPath, outputPath, dryRun);
        }
        return;
    }

    const inputPath = path.resolve(args[0]);
    const outputIndex = args.indexOf('-o') !== -1 ? args.indexOf('-o') + 1 : args.indexOf('--output') + 1;
    const outputPath = outputIndex > 0 && outputIndex < args.length
        ? path.resolve(args[outputIndex])
        : inputPath.replace(/\.json$/, '.v3.json');

    await processFile(inputPath, outputPath, dryRun);
}

async function processFile(inputPath: string, outputPath: string, dryRun: boolean): Promise<void> {
    if (!fs.existsSync(inputPath)) {
        console.error(`Error: file not found: ${inputPath}`);
        process.exit(1);
    }

    const raw = fs.readFileSync(inputPath, 'utf-8');
    let input: Record<string, any>;
    try {
        input = JSON.parse(raw);
    } catch (e) {
        console.error(`Error: invalid JSON in ${inputPath}`);
        process.exit(1);
    }

    try {
        const result = migrateFile(input);
        const output = JSON.stringify(result, null, 2);
        const inputSize = (Buffer.byteLength(raw) / 1024).toFixed(1);
        const outputSize = (Buffer.byteLength(output) / 1024).toFixed(1);
        console.log(`${path.basename(inputPath)} (${inputSize} KB) → ${path.basename(outputPath)} (${outputSize} KB) [${result.kind ?? 'prompt_base'}]`);
        if (!dryRun) {
            fs.writeFileSync(outputPath, output, 'utf-8');
        }
    } catch (e) {
        console.error(`Error processing ${path.basename(inputPath)}:`, (e as Error).message);
        process.exit(1);
    }
}

// 直接执行时跑 CLI；被测试导入时跳过入口。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
    main().catch((e) => {
        console.error('Fatal error:', e);
        process.exit(1);
    });
}