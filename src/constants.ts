import { chat_completion_sources } from '@sillytavern/scripts/openai';

export let EXTENSION_NAME = 'preset-cards';
try {
    const url = new URL(import.meta.url);
    const match = url.pathname.match(/\/scripts\/extensions\/(.*?)\/(?:dist\/)?index\.js/);
    if (match) EXTENSION_NAME = match[1];
} catch (e) {
    console.warn('preset-cards: could not determine extension path', e);
}

export const EXTENSION_KEY = 'preset_cards';

/** Keys in the preset object that map to a model name for each source */
export const MODEL_KEYS: Record<string, string> = {
    [chat_completion_sources.OPENAI]: 'openai_model',
    [chat_completion_sources.CLAUDE]: 'claude_model',
    [chat_completion_sources.OPENROUTER]: 'openrouter_model',
    [chat_completion_sources.AI21]: 'ai21_model',
    [chat_completion_sources.MAKERSUITE]: 'google_model',
    [chat_completion_sources.VERTEXAI]: 'vertexai_model',
    [chat_completion_sources.MISTRALAI]: 'mistralai_model',
    [chat_completion_sources.CUSTOM]: 'custom_model',
    [chat_completion_sources.COHERE]: 'cohere_model',
    [chat_completion_sources.PERPLEXITY]: 'perplexity_model',
    [chat_completion_sources.GROQ]: 'groq_model',
    [chat_completion_sources.ELECTRONHUB]: 'electronhub_model',
    [chat_completion_sources.CHUTES]: 'chutes_model',
    [chat_completion_sources.NANOGPT]: 'nanogpt_model',
    [chat_completion_sources.DEEPSEEK]: 'deepseek_model',
    [chat_completion_sources.AIMLAPI]: 'aimlapi_model',
    [chat_completion_sources.XAI]: 'xai_model',
    [chat_completion_sources.POLLINATIONS]: 'pollinations_model',
    [chat_completion_sources.MOONSHOT]: 'moonshot_model',
    [chat_completion_sources.FIREWORKS]: 'fireworks_model',
    [chat_completion_sources.COMETAPI]: 'cometapi_model',
    [chat_completion_sources.AZURE_OPENAI]: 'azure_openai_model',
    [chat_completion_sources.ZAI]: 'zai_model',
    [chat_completion_sources.SILICONFLOW]: 'siliconflow_model',
    [chat_completion_sources.WORKERS_AI]: 'workers_ai_model',
    [chat_completion_sources.MINIMAX]: 'minimax_model',
};

export const LOGO_BASE = `/scripts/extensions/${EXTENSION_NAME}/llm-logos/`;

export const LOCAL_DICT: Record<string, string> = {
    'Configurations': '配置快照',
    'Rename': '重命名',
    'Edit': '编辑',
    'Delete': '删除',
    'Load configuration': '加载该配置',
    'Configuration name:': '配置名称：',
    'Configuration updated': '配置已更新',
    'Configuration saved': '配置已保存',
    'Configuration loaded': '配置已加载',
    'Saving current preset state...': '正在保存当前预设状态...',
    'Applicable Models': '适用模型',
    'Add a short description for this preset...': '为该预设添加一段简短的描述...',
    'Description': '描述',
    'Search presets...': '搜索预设...',
    'presets': '个预设',
    'Multi-Select': '多选',
    'Batch Delete': '批量删除',
    'Import Preset': '导入预设',
    'Export configuration': '导出配置',
    'Export': '导出',
    'Export with branch chain': '包含关系链的导出',
    'Cancel': '取消',
    'Export all configurations': '导出全部配置文件',
    'Import configuration': '导入配置',
    'Failed to parse configuration file': '无法解析配置文件',
    'Concise Mode': '简洁模式',
    'No configurations saved for this preset': '该预设没有配置快照',
    'Background Image URL': '背景图片链接',
    'e.g., https://example.com/bg.jpg': '例如：https://example.com/bg.jpg',
    'Clear Cache': '清理缓存',
    'Clear all cached background images?': '确定要清理所有已缓存的背景图片吗？',
    'Cache cleared successfully': '缓存清理成功',
    'Save Base Profile': '保存当前 prompts 开关为主 profile',
    'Derive Profile': '派生',
    'Reset to parent': '重置回上一节点',
    'Reset this configuration to its parent?': '是否将此配置重置回上一节点？',
    'Delete this configuration?': '删除此配置？',
    'No default baseline available': '没有可用的默认基准',
    'Configuration reset': '配置已重置',
    'This profile type cannot be reset': '此类型配置无法重置',
    'This profile type cannot be edited with switches': '此类型配置无法用开关编辑',
    'Cannot derive from a legacy profile': '无法从旧版配置派生',
    'Base': '主',
    'Delta': '派生',
    'Derived': '派生',
    'No entries': '无条目',
    'Toggle entry': '切换条目开关',
    'Save changes': '保存修改',
    'Update current profile': '更新当前配置',
    'Create new subprofile': '新建为子配置',
    'Save changes to': '保存修改到：',
    'Edit prompt': '编辑 prompt',
    'Clear value changes': '清除值变更',
    'Role': '角色',
    'Name': '名称',
    'Content': '内容',
    'Position': '位置',
    'Relative': '相对',
    'In-chat': '对话中',
    'System': '系统',
    'User': '用户',
    'AI Assistant': 'AI 助手',
    'This is a marker prompt. Its content is managed by SillyTavern and cannot be edited here.': '这是标记 prompt，其内容由 SillyTavern 管理，此处不可编辑。',
    'Base profile name:': '主 profile 名称：',
    'Base profile saved': '主 profile 已保存',
    'Derived profile name:': '派生 profile 名称：',
    'Derived profile created': '派生 profile 已创建',
    'Base profile not found, applying changes only': '未找到主 profile，仅应用派生差异',
    'Base profile not found, cannot update derived configuration': '未找到主 profile，无法更新派生配置',
    'Base profile not found for this imported derived configuration': '导入的派生配置未找到对应的主 profile',
    'Legacy v1 profiles are not included in the tree export': '旧版 v1 配置快照不包含在关系链导出中',
    'Missing prompts skipped': '缺失的 prompt 已跳过',
    'This will also delete the following derived configurations': '将一并删除以下派生配置',
    'In Chat Absolute Depth': '对话内绝对深度',
    'Injection Depth': '注入深度',
    'View Staged': '查看暂存',
    'Commit': '提交',
    'Close': '关闭',
    'Search prompts...': '搜索 prompts...',
    'Drag to reorder': '拖拽排序',
    'Staged Changes': '暂存更改',
    'No staged changes': '暂无暂存更改',
    'Undo': '撤销',
    'Switch': '开关',
    'On': '开',
    'Off': '关',
    'You have uncommitted changes': '您还有未提交的更改',
    'You have uncommitted changes. Discard them?': '您还有未提交的更改，要丢弃吗？',
    'Uncommitted changes discarded': '未提交的更改已丢弃',
    'Back to list': '返回列表',
    'Save': '保存',
    'No prompts found': '未找到匹配的 prompt',
    'Unused Prompts': '未使用 Prompts',
    'Not used for generation': '未参与生成',
    'Activate prompt': '激活 prompt',
    'Move to unused': '移到未使用',
    'Usage status': '使用状态',
    'Active': '活动',
    'Unused': '未使用',
    'Order adjusted': '顺序已调整',
    'Legacy profiles are not included in the tree export': '旧版 v1/v2 配置不会包含在关系链导出中',
    'Legacy profiles must be rebuilt manually': '仅支持导入 v3 配置；旧版 v1/v2 配置需要手动重建',
};

export interface ModelDef {
    id: string;
    label: string;
    logo: string;
}

export const AVAILABLE_MODELS: ModelDef[] = [
    { id: 'claude',   label: 'Claude',   logo: 'claude-color.png'   },
    { id: 'gemini',   label: 'Gemini',   logo: 'gemini-color.png'   },
    { id: 'chatgpt',  label: 'ChatGPT',  logo: 'chatgpt.png'        },
    { id: 'deepseek', label: 'DeepSeek', logo: 'deepseek-color.png' },
    { id: 'chatglm',  label: 'ChatGLM',  logo: 'chatglm-color.png'  },
    { id: 'grok',     label: 'Grok',     logo: 'grok.png'           },
    { id: 'kimi',     label: 'Kimi',     logo: 'kimi-color.png'     },
];

/** Map model id → full logo URL */
export const MODEL_LOGO_MAP: Record<string, string> = Object.fromEntries(
    AVAILABLE_MODELS.map(m => [m.id, LOGO_BASE + m.logo]),
);

/** Friendly labels for chat completion sources */
export const SOURCE_LABELS: Record<string, string> = {
    [chat_completion_sources.OPENAI]: 'OpenAI',
    [chat_completion_sources.CLAUDE]: 'Claude',
    [chat_completion_sources.OPENROUTER]: 'OpenRouter',
    [chat_completion_sources.AI21]: 'AI21',
    [chat_completion_sources.MAKERSUITE]: 'Google AI',
    [chat_completion_sources.VERTEXAI]: 'Vertex AI',
    [chat_completion_sources.MISTRALAI]: 'Mistral AI',
    [chat_completion_sources.CUSTOM]: 'Custom',
    [chat_completion_sources.COHERE]: 'Cohere',
    [chat_completion_sources.PERPLEXITY]: 'Perplexity',
    [chat_completion_sources.GROQ]: 'Groq',
    [chat_completion_sources.ELECTRONHUB]: 'ElectronHub',
    [chat_completion_sources.CHUTES]: 'Chutes',
    [chat_completion_sources.NANOGPT]: 'NanoGPT',
    [chat_completion_sources.DEEPSEEK]: 'DeepSeek',
    [chat_completion_sources.AIMLAPI]: 'AIML API',
    [chat_completion_sources.XAI]: 'xAI',
    [chat_completion_sources.POLLINATIONS]: 'Pollinations',
    [chat_completion_sources.MOONSHOT]: 'Moonshot',
    [chat_completion_sources.FIREWORKS]: 'Fireworks',
    [chat_completion_sources.COMETAPI]: 'CometAPI',
    [chat_completion_sources.AZURE_OPENAI]: 'Azure OpenAI',
    [chat_completion_sources.ZAI]: 'ZhipuAI',
    [chat_completion_sources.SILICONFLOW]: 'SiliconFlow',
    [chat_completion_sources.WORKERS_AI]: 'Workers AI',
    [chat_completion_sources.MINIMAX]: 'MiniMax',
};

/** Source → logo mapping (reuses the logos that match) */
export const SOURCE_LOGO_MAP: Record<string, string> = {
    [chat_completion_sources.CLAUDE]: MODEL_LOGO_MAP['claude'],
    [chat_completion_sources.MAKERSUITE]: MODEL_LOGO_MAP['gemini'],
    [chat_completion_sources.VERTEXAI]: MODEL_LOGO_MAP['gemini'],
    [chat_completion_sources.DEEPSEEK]: MODEL_LOGO_MAP['deepseek'],
    [chat_completion_sources.ZAI]: MODEL_LOGO_MAP['chatglm'],
    [chat_completion_sources.XAI]: MODEL_LOGO_MAP['grok'],
    [chat_completion_sources.MOONSHOT]: MODEL_LOGO_MAP['kimi'],
};
