/** ST openai 模块的最小 mock：测试可写状态后按需重置。 */

export const settingsToUpdate: Record<string, [string, string, boolean, boolean]> = {
    chat_completion_source: ['#chat_completion_source', 'chat_completion_source', false, true],
    stream_openai: ['#stream_openai', 'stream_openai', true, false],
    show_thoughts: ['#openai_show_thoughts', 'show_thoughts', true, false],
    openai_model: ['#openai_model', 'openai_model', false, true],
    claude_model: ['#claude_model', 'claude_model', false, true],
    custom_url: ['#custom_url', 'custom_url', false, true],
    reverse_proxy: ['#reverse_proxy', 'reverse_proxy', false, true],
    proxy_password: ['#proxy_password', 'proxy_password', false, true],
    openai_max_context: ['#openai_max_context', 'openai_max_context', false, false],
    openai_max_tokens: ['#openai_max_tokens', 'openai_max_tokens', false, false],
    temperature: ['#temperature', 'temperature', false, false],
    top_p: ['#top_p', 'top_p', false, false],
    top_k: ['#top_k', 'top_k', false, false],
    stream_openai2: ['#stream_openai2', 'stream_openai2', true, false],
    // fastApplyPreset 依赖这两键把 prompts/order 拷贝进运行时（对齐真实 ST settingsToUpdate）
    prompts: ['#prompt_manager', 'prompts', false, false],
    prompt_order: ['#prompt_manager', 'prompt_order', false, false],
};

export const chat_completion_sources: Record<string, string> = {
    OPENAI: 'openai',
    CLAUDE: 'claude',
    OPENROUTER: 'openrouter',
    AI21: 'ai21',
    MAKERSUITE: 'makersuite',
    VERTEXAI: 'vertexai',
    MISTRALAI: 'mistralai',
    CUSTOM: 'custom',
    COHERE: 'cohere',
    PERPLEXITY: 'perplexity',
    GROQ: 'groq',
    ELECTRONHUB: 'electronhub',
    CHUTES: 'chutes',
    NANOGPT: 'nanogpt',
    DEEPSEEK: 'deepseek',
    AIMLAPI: 'aimlapi',
    XAI: 'xai',
    POLLINATIONS: 'pollinations',
    MOONSHOT: 'moonshot',
    FIREWORKS: 'fireworks',
    COMETAPI: 'cometapi',
    AZURE_OPENAI: 'azure_openai',
    ZAI: 'zai',
    SILICONFLOW: 'siliconflow',
    WORKERS_AI: 'workers_ai',
    MINIMAX: 'minimax',
};

export const custom_prompt_post_processing_types = { CLAUDE: 'claude', MERGE: 'merge' };

export const openai_settings: Record<string, unknown>[] = [];
export const openai_setting_names: Record<string, number> = {};
export const oai_settings: Record<string, unknown> = { preset_settings_openai: null, extensions: {} };
export const promptManager: { configuration: { promptOrder: { strategy: 'global' | 'character'; dummyId?: number } }; activeCharacter?: { id: number } | null } | null = null;

export function getChatCompletionPreset(settings: Record<string, unknown>): Record<string, unknown> {
    return settings;
}

export function resetOpenaiMock(): void {
    openai_settings.length = 0;
    for (const key of Object.keys(openai_setting_names)) delete openai_setting_names[key];
    Object.keys(oai_settings).forEach((key) => delete oai_settings[key]);
    oai_settings.preset_settings_openai = null;
    oai_settings.extensions = {};
}

/** 测试辅助：注册一个带 extensions 元数据的预设。 */
export function addPreset(name: string, preset: Record<string, unknown>): number {
    const idx = openai_settings.length;
    openai_settings.push(preset);
    openai_setting_names[name] = idx;
    return idx;
}
