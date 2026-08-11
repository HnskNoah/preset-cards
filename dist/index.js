import { t } from '/scripts/i18n.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { saveSettingsDebounced, getRequestHeaders } from '/script.js';
import { cancelDebounce, download } from '/scripts/utils.js';
import { eventSource, event_types } from '/scripts/events.js';
import { openai_settings, oai_settings, settingsToUpdate, promptManager, chat_completion_sources, custom_prompt_post_processing_types, openai_setting_names, getChatCompletionPreset } from '/scripts/openai.js';
import { ToolManager } from '/scripts/tool-calling.js';
import { renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT, Popup } from '/scripts/popup.js';

const CHARACTER_NAMES_BEHAVIOR = { COMPLETION: 1};
function migrateLegacyPresetFields(preset) {
  const migrateMap = [
    { oldKey: "names_in_completion", oldValue: true, newKey: "names_behavior", newValue: CHARACTER_NAMES_BEHAVIOR.COMPLETION },
    { oldKey: "chat_completion_source", oldValue: "palm", newKey: "chat_completion_source", newValue: chat_completion_sources.MAKERSUITE },
    { oldKey: "custom_prompt_post_processing", oldValue: custom_prompt_post_processing_types.CLAUDE, newKey: "custom_prompt_post_processing", newValue: custom_prompt_post_processing_types.MERGE },
    { oldKey: "ai21_model", oldValue: /^j2-/, newKey: "ai21_model", newValue: "jamba-large" },
    { oldKey: "image_inlining", oldValue: false, newKey: "media_inlining", newValue: false },
    { oldKey: "image_inlining", oldValue: true, newKey: "media_inlining", newValue: true },
    { oldKey: "video_inlining", oldValue: true, newKey: "media_inlining", newValue: true },
    { oldKey: "audio_inlining", oldValue: true, newKey: "media_inlining", newValue: true },
    { oldKey: "claude_use_sysprompt", oldValue: true, newKey: "use_sysprompt", newValue: true },
    { oldKey: "use_makersuite_sysprompt", oldValue: true, newKey: "use_sysprompt", newValue: true },
    { oldKey: "mistralai_model", oldValue: /^(mistral-medium|mistral-small)$/, newKey: "mistralai_model", newValue: `${preset.mistralai_model}-latest` },
    { oldKey: "deepseek_model", oldValue: /^deepseek-(chat|reasoner|coder)$/, newKey: "deepseek_model", newValue: "deepseek-v4-flash" },
    { oldKey: "openrouter_sort_models", oldValue: "alphabetically", newKey: "sort_models", newValue: "alphabetically" },
    { oldKey: "openrouter_sort_models", oldValue: "pricing.prompt", newKey: "sort_models", newValue: "pricing.prompt" },
    { oldKey: "openrouter_sort_models", oldValue: "context_length", newKey: "sort_models", newValue: "context_length" },
    { oldKey: "openrouter_group_models", oldValue: true, newKey: "group_models", newValue: true }
  ];
  for (const migration of migrateMap) {
    if (!Object.hasOwn(preset, migration.oldKey)) continue;
    const shouldMigrate = migration.oldValue instanceof RegExp ? migration.oldValue.test(String(preset[migration.oldKey])) : preset[migration.oldKey] === migration.oldValue;
    if (shouldMigrate) preset[migration.newKey] = migration.newValue;
    if (migration.oldKey !== migration.newKey) delete preset[migration.oldKey];
  }
}
async function fastApplyPreset(presetIndex, presetName) {
  const preset = openai_settings[presetIndex];
  if (!preset) return;
  const presetNameBefore = oai_settings.preset_settings_openai;
  oai_settings.preset_settings_openai = presetName;
  migrateLegacyPresetFields(preset);
  await eventSource.emit(event_types.OAI_PRESET_CHANGED_BEFORE, {
    preset,
    presetName,
    settingsToUpdate,
    settings: oai_settings,
    savePreset: null,
    // 仅用于迁移；保存由本路径统一处理
    presetNameBefore
  });
  for (const [key, [, settingName, , isConnection]] of Object.entries(settingsToUpdate)) {
    if (isConnection && !oai_settings.bind_preset_to_connection) {
      continue;
    }
    if (key === "extensions") {
      oai_settings.extensions = structuredClone(preset.extensions || {});
      continue;
    }
    if (preset[key] !== void 0) {
      oai_settings[settingName] = key === "prompts" || key === "prompt_order" ? structuredClone(preset[key]) : preset[key];
    }
  }
  ToolManager.RECURSE_LIMIT = oai_settings.tool_call_recurse_limit ?? 5;
  if (oai_settings.bind_preset_to_connection) {
    $(".model_custom_select").empty();
  }
  for (const [key, [selector, , isCheckbox, isConnection]] of Object.entries(settingsToUpdate)) {
    if (isConnection && !oai_settings.bind_preset_to_connection) continue;
    if (!selector || selector === "" || selector === "#NULL_SELECTOR") continue;
    if (preset[key] === void 0) continue;
    const el = document.querySelector(selector);
    if (!el) continue;
    if (isCheckbox) {
      el.checked = !!preset[key];
    } else {
      el.value = preset[key];
    }
    if (el.type === "range" && el.id) {
      const counter = document.querySelector(`input[type="number"][data-for="${el.id}"]`);
      if (counter) counter.value = String(Number(preset[key]));
    }
  }
  const selectEl = document.querySelector("#settings_preset_openai");
  if (selectEl) selectEl.value = String(presetIndex);
  if (oai_settings.bind_preset_to_connection) {
    $("#chat_completion_source").trigger("change");
    $("#openrouter_providers_chat").trigger("change");
    $("#openrouter_quantizations_chat").trigger("change");
    $("#nanogpt_provider").trigger("change");
  }
  $("#openai_logit_bias_preset").trigger("change");
  saveSettingsDebounced();
  await eventSource.emit(event_types.OAI_PRESET_CHANGED_AFTER);
  await eventSource.emit(event_types.PRESET_CHANGED, { apiId: "openai", name: presetName });
  const pm = promptManager;
  if (pm) {
    cancelDebounce(pm.renderDebounced);
    pm.render(false);
  }
}

let EXTENSION_NAME = "preset-cards";
try {
  const url = new URL(import.meta.url);
  const match = url.pathname.match(/\/scripts\/extensions\/(.*?)\/(?:dist\/)?index\.js/);
  if (match) EXTENSION_NAME = match[1];
} catch (e) {
  console.warn("preset-cards: could not determine extension path", e);
}
const EXTENSION_KEY = "preset_cards";
const MODEL_KEYS = {
  [chat_completion_sources.OPENAI]: "openai_model",
  [chat_completion_sources.CLAUDE]: "claude_model",
  [chat_completion_sources.OPENROUTER]: "openrouter_model",
  [chat_completion_sources.AI21]: "ai21_model",
  [chat_completion_sources.MAKERSUITE]: "google_model",
  [chat_completion_sources.VERTEXAI]: "vertexai_model",
  [chat_completion_sources.MISTRALAI]: "mistralai_model",
  [chat_completion_sources.CUSTOM]: "custom_model",
  [chat_completion_sources.COHERE]: "cohere_model",
  [chat_completion_sources.PERPLEXITY]: "perplexity_model",
  [chat_completion_sources.GROQ]: "groq_model",
  [chat_completion_sources.ELECTRONHUB]: "electronhub_model",
  [chat_completion_sources.CHUTES]: "chutes_model",
  [chat_completion_sources.NANOGPT]: "nanogpt_model",
  [chat_completion_sources.DEEPSEEK]: "deepseek_model",
  [chat_completion_sources.AIMLAPI]: "aimlapi_model",
  [chat_completion_sources.XAI]: "xai_model",
  [chat_completion_sources.POLLINATIONS]: "pollinations_model",
  [chat_completion_sources.MOONSHOT]: "moonshot_model",
  [chat_completion_sources.FIREWORKS]: "fireworks_model",
  [chat_completion_sources.COMETAPI]: "cometapi_model",
  [chat_completion_sources.AZURE_OPENAI]: "azure_openai_model",
  [chat_completion_sources.ZAI]: "zai_model",
  [chat_completion_sources.SILICONFLOW]: "siliconflow_model",
  [chat_completion_sources.WORKERS_AI]: "workers_ai_model",
  [chat_completion_sources.MINIMAX]: "minimax_model"
};
const LOGO_BASE = `/scripts/extensions/${EXTENSION_NAME}/llm-logos/`;
const SAMPLING_KEYS = [
  "temperature",
  "top_p",
  "top_k",
  "top_a",
  "min_p",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "seed",
  "n",
  "openai_max_context",
  "openai_max_tokens",
  "stream_openai"
];
const LOCAL_DICT = {
  "Configurations": "配置快照",
  "Rename": "重命名",
  "Edit": "编辑",
  "Delete": "删除",
  "Load configuration": "加载该配置",
  "Configuration name:": "配置名称：",
  "Configuration updated": "配置已更新",
  "Configuration saved": "配置已保存",
  "Configuration loaded": "配置已加载",
  "Saving current preset state...": "正在保存当前预设状态...",
  "Applicable Models": "适用模型",
  "Add a short description for this preset...": "为该预设添加一段简短的描述...",
  "Description": "描述",
  "Sampling": "采样参数",
  "Context": "上下文",
  "Tokens": "回复 Tokens",
  "Streaming": "流式输出",
  "Search presets...": "搜索预设...",
  "presets": "个预设",
  "Multi-Select": "多选",
  "Batch Delete": "批量删除",
  "Import Preset": "导入预设",
  "Export configuration": "导出配置",
  "Export": "导出",
  "Export with branch chain": "包含关系链的导出",
  "Cancel": "取消",
  "Export all configurations": "导出全部配置文件",
  "Import configuration": "导入配置",
  "Failed to parse configuration file": "无法解析配置文件",
  "Concise Mode": "简洁模式",
  "No configurations saved for this preset": "该预设没有配置快照",
  "Background Image URL": "背景图片链接",
  "e.g., https://example.com/bg.jpg": "例如：https://example.com/bg.jpg",
  "Clear Cache": "清理缓存",
  "Clear all cached background images?": "确定要清理所有已缓存的背景图片吗？",
  "Cache cleared successfully": "缓存清理成功",
  "Save Base Profile": "保存当前 prompts 开关为主 profile",
  "Derive Profile": "派生",
  "Reset to parent": "重置回上一节点",
  "Reset this configuration to its parent?": "是否将此配置重置回上一节点？",
  "Delete this configuration?": "删除此配置？",
  "No default baseline available": "没有可用的默认基准",
  "Configuration reset": "配置已重置",
  "This profile type cannot be reset": "此类型配置无法重置",
  "This profile type cannot be edited with switches": "此类型配置无法用开关编辑",
  "Cannot derive from a legacy profile": "无法从旧版配置派生",
  "No entries": "无条目",
  "Toggle entry": "切换条目开关",
  "Save changes": "保存修改",
  "Update current profile": "更新当前配置",
  "Create new subprofile": "新建为子配置",
  "Save changes to": "保存修改到：",
  "Edit prompt": "编辑 prompt",
  "Clear value changes": "清除值变更",
  "Role": "角色",
  "Name": "名称",
  "Content": "内容",
  "Position": "位置",
  "Relative": "相对",
  "In-chat": "对话中",
  "System": "系统",
  "User": "用户",
  "AI Assistant": "AI 助手",
  "This is a marker prompt. Its content is managed by SillyTavern and cannot be edited here.": "这是标记 prompt，其内容由 SillyTavern 管理，此处不可编辑。",
  "Base profile name:": "主 profile 名称：",
  "Base profile saved": "主 profile 已保存",
  "Derived profile name:": "派生 profile 名称：",
  "Derived profile created": "派生 profile 已创建",
  "Base profile not found, applying changes only": "未找到主 profile，仅应用派生差异",
  "Base profile not found, cannot update derived configuration": "未找到主 profile，无法更新派生配置",
  "Base profile not found for this imported derived configuration": "导入的派生配置未找到对应的主 profile",
  "Legacy v1 profiles are not included in the tree export": "旧版 v1 配置快照不包含在关系链导出中",
  "Missing prompts skipped": "缺失的 prompt 已跳过",
  "This will also delete the following derived configurations": "将一并删除以下派生配置",
  "In Chat Absolute Depth": "对话内绝对深度",
  "Injection Depth": "注入深度",
  "View Staged": "暂存",
  "Lock list": "锁定列表",
  "Unlock list": "解锁列表",
  "Commit": "提交",
  "Close": "关闭",
  "Back": "返回",
  "Search prompts...": "搜索 prompts...",
  "Drag to reorder": "拖拽排序",
  "Staged Changes": "暂存更改",
  "No staged changes": "暂无暂存更改",
  "Undo": "撤销",
  "Switch": "开关",
  "On": "开",
  "Off": "关",
  "You have uncommitted changes": "您还有未提交的更改",
  "You have uncommitted changes. Discard them?": "您还有未提交的更改，要丢弃吗？",
  "Uncommitted changes discarded": "未提交的更改已丢弃",
  "Save": "保存",
  "No prompts found": "未找到匹配的 prompt"
};
const AVAILABLE_MODELS = [
  { id: "claude", label: "Claude", logo: "claude-color.png" },
  { id: "gemini", label: "Gemini", logo: "gemini-color.png" },
  { id: "chatgpt", label: "ChatGPT", logo: "chatgpt.png" },
  { id: "deepseek", label: "DeepSeek", logo: "deepseek-color.png" },
  { id: "chatglm", label: "ChatGLM", logo: "chatglm-color.png" },
  { id: "grok", label: "Grok", logo: "grok.png" },
  { id: "kimi", label: "Kimi", logo: "kimi-color.png" }
];
const MODEL_LOGO_MAP = Object.fromEntries(
  AVAILABLE_MODELS.map((m) => [m.id, LOGO_BASE + m.logo])
);
const SOURCE_LABELS = {
  [chat_completion_sources.OPENAI]: "OpenAI",
  [chat_completion_sources.CLAUDE]: "Claude",
  [chat_completion_sources.OPENROUTER]: "OpenRouter",
  [chat_completion_sources.AI21]: "AI21",
  [chat_completion_sources.MAKERSUITE]: "Google AI",
  [chat_completion_sources.VERTEXAI]: "Vertex AI",
  [chat_completion_sources.MISTRALAI]: "Mistral AI",
  [chat_completion_sources.CUSTOM]: "Custom",
  [chat_completion_sources.COHERE]: "Cohere",
  [chat_completion_sources.PERPLEXITY]: "Perplexity",
  [chat_completion_sources.GROQ]: "Groq",
  [chat_completion_sources.ELECTRONHUB]: "ElectronHub",
  [chat_completion_sources.CHUTES]: "Chutes",
  [chat_completion_sources.NANOGPT]: "NanoGPT",
  [chat_completion_sources.DEEPSEEK]: "DeepSeek",
  [chat_completion_sources.AIMLAPI]: "AIML API",
  [chat_completion_sources.XAI]: "xAI",
  [chat_completion_sources.POLLINATIONS]: "Pollinations",
  [chat_completion_sources.MOONSHOT]: "Moonshot",
  [chat_completion_sources.FIREWORKS]: "Fireworks",
  [chat_completion_sources.COMETAPI]: "CometAPI",
  [chat_completion_sources.AZURE_OPENAI]: "Azure OpenAI",
  [chat_completion_sources.ZAI]: "ZhipuAI",
  [chat_completion_sources.SILICONFLOW]: "SiliconFlow",
  [chat_completion_sources.WORKERS_AI]: "Workers AI",
  [chat_completion_sources.MINIMAX]: "MiniMax"
};
const SOURCE_LOGO_MAP = {
  [chat_completion_sources.CLAUDE]: MODEL_LOGO_MAP["claude"],
  [chat_completion_sources.MAKERSUITE]: MODEL_LOGO_MAP["gemini"],
  [chat_completion_sources.VERTEXAI]: MODEL_LOGO_MAP["gemini"],
  [chat_completion_sources.DEEPSEEK]: MODEL_LOGO_MAP["deepseek"],
  [chat_completion_sources.ZAI]: MODEL_LOGO_MAP["chatglm"],
  [chat_completion_sources.XAI]: MODEL_LOGO_MAP["grok"],
  [chat_completion_sources.MOONSHOT]: MODEL_LOGO_MAP["kimi"]
};

function L(text) {
  const lang = localStorage.getItem("language") || "en";
  if (lang.startsWith("zh") && LOCAL_DICT[text]) {
    return LOCAL_DICT[text];
  }
  return text;
}

function isPromptBaseProfile(profile) {
  return profile.kind === "prompt_base";
}
function isPromptDeltaProfile(profile) {
  return profile.kind === "prompt_delta";
}
function getProfile(meta, profileId) {
  return meta.profiles.find((p) => p.id === String(profileId));
}
function newProfileId() {
  return Date.now().toString() + Math.floor(Math.random() * 1e3);
}
function readMeta(preset) {
  const ext = preset?.extensions?.[EXTENSION_KEY];
  return {
    description: ext?.description || "",
    models: Array.isArray(ext?.models) ? ext.models : [],
    profiles: Array.isArray(ext?.profiles) ? ext.profiles : [],
    bgImage: ext?.bgImage || "",
    defaultSnapshot: Array.isArray(ext?.defaultSnapshot) ? ext.defaultSnapshot : void 0,
    defaultSnapshotLocked: ext?.defaultSnapshotLocked === true,
    defaultExtra: ext?.defaultExtra && typeof ext.defaultExtra === "object" && !Array.isArray(ext.defaultExtra) ? ext.defaultExtra : void 0
  };
}
async function saveMeta(presetName, presetIndex, meta) {
  const preset = openai_settings[presetIndex];
  if (!preset) return;
  if (!preset.extensions) preset.extensions = {};
  preset.extensions[EXTENSION_KEY] = {
    description: meta.description || "",
    models: meta.models || [],
    profiles: meta.profiles || [],
    bgImage: meta.bgImage || "",
    defaultSnapshot: meta.defaultSnapshot,
    defaultSnapshotLocked: meta.defaultSnapshotLocked === true,
    defaultExtra: meta.defaultExtra
  };
  if (oai_settings.preset_settings_openai === presetName) {
    if (!oai_settings.extensions) oai_settings.extensions = {};
    oai_settings.extensions[EXTENSION_KEY] = preset.extensions[EXTENSION_KEY];
  }
  const presetBody = structuredClone(preset);
  const response = await fetch("/api/presets/save", {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify({
      apiId: "openai",
      name: presetName,
      preset: presetBody
    })
  });
  if (!response.ok) {
    toastr.error(t`Failed to save preset metadata`);
    console.error("Failed to save preset metadata", response);
    throw new Error("Failed to save preset metadata");
  }
}

const PROMPT_FIELD_WHITELIST = [
  "content",
  "name",
  "role",
  "injection_position",
  "injection_depth"
];
function promptFieldsEqual(a, b) {
  return PROMPT_FIELD_WHITELIST.every((key) => a[key] === b[key]);
}
function captureSampling(preset) {
  const sampling = {};
  for (const key of SAMPLING_KEYS) {
    const value = preset[key];
    if (value !== void 0) {
      sampling[key] = value;
    }
  }
  return Object.keys(sampling).length > 0 ? sampling : null;
}
function applySampling(preset, sampling) {
  const target = preset;
  for (const key of SAMPLING_KEYS) {
    const value = sampling[key];
    if (value !== void 0) target[key] = value;
  }
}
const EXTRA_EXCLUDED_KEYS = /* @__PURE__ */ new Set([
  "prompts",
  "prompt_order",
  "extensions",
  "name",
  ...Object.keys(settingsToUpdate).filter((key) => settingsToUpdate[key]?.[3] === true)
]);
function captureExtra(settings) {
  const extra = {};
  for (const [key, value] of Object.entries(settings)) {
    if (SAMPLING_KEYS.some((k) => k === key)) continue;
    if (EXTRA_EXCLUDED_KEYS.has(key)) continue;
    extra[key] = value;
  }
  return Object.keys(extra).length > 0 ? extra : null;
}
function applyExtra(preset, extra) {
  const ext = preset.extensions;
  Object.assign(preset, extra);
  preset.extensions = ext;
}
function capturePromptFields(prompt) {
  const fields = {};
  if (!prompt) return fields;
  for (const key of PROMPT_FIELD_WHITELIST) {
    const value = prompt[key];
    if (value !== void 0) {
      fields[key] = value;
    }
  }
  return fields;
}
function filterFields(fields) {
  const out = {};
  if (!fields) return out;
  for (const key of PROMPT_FIELD_WHITELIST) {
    if (fields[key] !== void 0) out[key] = fields[key];
  }
  return out;
}
function mirrorFieldsToActivePreset(presetName, identifier, fields) {
  if (oai_settings.preset_settings_openai !== presetName) return;
  const livePrompts = Array.isArray(oai_settings.prompts) ? oai_settings.prompts : [];
  const livePrompt = livePrompts.find((p) => p && p.identifier === identifier);
  if (livePrompt) {
    Object.assign(livePrompt, filterFields(fields));
  }
}
function findPromptInPreset(preset, identifier) {
  const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
  return prompts.find((p) => p && p.identifier === identifier);
}
function applyEntryState(preset, identifier, enabled) {
  const prompt = findPromptInPreset(preset, identifier);
  if (!prompt) return false;
  prompt.enabled = enabled;
  syncPromptOrder(preset, [{ identifier, enabled }]);
  return true;
}
function runtimeEnabledFor(prompt, preset, characterId = 100001) {
  const orderEnabled = promptOrderEnabledFor(preset, prompt.identifier, characterId);
  if (orderEnabled !== void 0) return orderEnabled;
  return prompt.enabled ?? true;
}
function promptOrderEnabledFor(preset, identifier, characterId = 100001) {
  const list = Array.isArray(preset.prompt_order) ? preset.prompt_order.find((x) => x && String(x.character_id) === String(characterId)) : void 0;
  if (Array.isArray(list?.order)) {
    const order = list.order.find((o) => o && o.identifier === identifier);
    if (order && typeof order.enabled === "boolean") {
      return order.enabled;
    }
  }
  return void 0;
}
function buildDefaultSnapshotLock(preset) {
  if (!Array.isArray(preset.prompts)) return [];
  return preset.prompts.filter((p) => p && typeof p.identifier === "string" && p.identifier).map((p) => {
    const enabled = promptOrderEnabledFor(preset, p.identifier);
    return {
      identifier: p.identifier,
      ...enabled !== void 0 ? { enabled } : {},
      originalFields: capturePromptFields(p)
    };
  });
}
function applyBaseProfile(preset, profile) {
  const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
  const byIdentifier = new Map(
    prompts.filter((p) => p && typeof p.identifier === "string" && p.identifier).map((p) => [p.identifier, p])
  );
  const orderEntries = [];
  for (const entry of profile.prompts) {
    const prompt = byIdentifier.get(entry.identifier);
    if (!prompt) continue;
    prompt.enabled = entry.enabled;
    if (entry.fields) {
      Object.assign(prompt, filterFields(entry.fields));
    }
    orderEntries.push({ identifier: entry.identifier, enabled: entry.enabled });
  }
  if (orderEntries.length > 0) {
    syncPromptOrder(preset, orderEntries);
  }
  if (profile.sampling) {
    applySampling(preset, profile.sampling);
  }
  if (profile.extra) {
    applyExtra(preset, profile.extra);
  }
}
function resolveParentStates(profile, allProfiles) {
  const parent = allProfiles.find((p) => p.id === profile.baseId);
  if (!parent) return [];
  return resolveProfilePrompts(parent, allProfiles);
}
function resolveProfilePrompts(profile, allProfiles, seen = /* @__PURE__ */ new Set()) {
  if (!profile || seen.has(profile.id)) return [];
  seen.add(profile.id);
  if (isPromptBaseProfile(profile)) {
    return structuredClone(profile.prompts);
  }
  if (!isPromptDeltaProfile(profile)) {
    return [];
  }
  const parent = allProfiles.find((p) => p.id === profile.baseId);
  const entries = parent ? resolveProfilePrompts(parent, allProfiles, seen) : [];
  const map = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    map.set(entry.identifier, {
      identifier: entry.identifier,
      enabled: entry.enabled,
      fields: entry.fields ? { ...entry.fields } : void 0
    });
  }
  for (const change of profile.changes) {
    const existing = map.get(change.identifier);
    if (existing) {
      if (change.enabled !== void 0) {
        existing.enabled = change.enabled;
      }
      if (change.fields) {
        existing.fields = Object.assign({}, existing.fields, change.fields);
      }
    } else if (change.enabled !== void 0) {
      map.set(change.identifier, {
        identifier: change.identifier,
        enabled: change.enabled,
        fields: change.fields ? { ...change.fields } : void 0
      });
    }
  }
  return [...map.values()];
}
function applyDeltaProfile(preset, delta, base) {
  const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
  const byIdentifier = new Map(
    prompts.filter((p) => p && typeof p.identifier === "string" && p.identifier).map((p) => [p.identifier, p])
  );
  const orderEntries = [];
  const missing = [];
  let matched = 0;
  for (const change of delta.changes) {
    const prompt = byIdentifier.get(change.identifier);
    if (!prompt) {
      missing.push(change.identifier);
      continue;
    }
    if (change.enabled !== void 0) {
      prompt.enabled = change.enabled;
    }
    if (change.fields) {
      Object.assign(prompt, filterFields(change.fields));
    }
    orderEntries.push({ identifier: change.identifier, enabled: !!prompt.enabled });
    matched++;
  }
  if (orderEntries.length > 0) {
    syncPromptOrder(preset, orderEntries);
  }
  if (delta.sampling) {
    applySampling(preset, delta.sampling);
  }
  if (delta.extra) {
    applyExtra(preset, delta.extra);
  }
  return { matched, missing };
}
function findOrderList(preset, characterId) {
  if (!Array.isArray(preset.prompt_order)) return void 0;
  return preset.prompt_order.find((x) => x && String(x.character_id) === String(characterId));
}
function pruneStaleOrderEntries(preset) {
  if (!Array.isArray(preset.prompts)) return;
  const list = findOrderList(preset, resolvePromptOrderTarget());
  if (!list?.order || !Array.isArray(list.order)) return;
  const validIds = /* @__PURE__ */ new Set();
  for (const p of preset.prompts) {
    if (p && typeof p.identifier === "string" && p.identifier) validIds.add(p.identifier);
  }
  const filtered = list.order.filter((o) => o && validIds.has(o.identifier));
  if (filtered.length !== list.order.length) {
    list.order = filtered;
  }
}
function resolvePromptOrderTarget() {
  const strategy = promptManager?.configuration?.promptOrder?.strategy;
  if (strategy === "character") {
    return promptManager?.activeCharacter?.id ?? 100001;
  }
  return 100001;
}
function syncPromptOrder(preset, entries) {
  const list = findOrderList(preset, resolvePromptOrderTarget());
  if (!Array.isArray(list?.order)) return;
  for (const entry of entries) {
    const existing = list.order.find((o) => o?.identifier === entry.identifier);
    if (existing) {
      existing.enabled = entry.enabled;
    }
  }
}
function promptOrderIdentifiers(preset) {
  const list = findOrderList(preset, resolvePromptOrderTarget());
  if (!Array.isArray(list?.order)) return /* @__PURE__ */ new Set();
  return new Set(
    list.order.filter((entry) => entry && typeof entry.identifier === "string" && entry.identifier).map((entry) => entry.identifier)
  );
}
function buildPromptSnapshot(preset, opts) {
  if (!Array.isArray(preset.prompts)) return [];
  const orderIdentifiers = promptOrderIdentifiers(preset);
  return preset.prompts.filter((p) => p && typeof p.identifier === "string" && orderIdentifiers.has(p.identifier)).map((p) => {
    const entry = {
      identifier: p.identifier,
      enabled: runtimeEnabledFor(p, preset, resolvePromptOrderTarget())
    };
    if (opts?.includeFields?.has(p.identifier)) {
      entry.fields = capturePromptFields(p);
    }
    return entry;
  });
}
function buildBaseSnapshotDiff(preset, baseline) {
  if (!Array.isArray(preset.prompts)) return [];
  const orderIdentifiers = promptOrderIdentifiers(preset);
  const baselineFields = /* @__PURE__ */ new Map();
  if (Array.isArray(baseline)) {
    for (const entry of baseline) {
      if (entry.originalFields) baselineFields.set(entry.identifier, entry.originalFields);
    }
  }
  return preset.prompts.filter((p) => p && typeof p.identifier === "string" && orderIdentifiers.has(p.identifier)).map((p) => {
    const entry = {
      identifier: p.identifier,
      enabled: runtimeEnabledFor(p, preset, resolvePromptOrderTarget())
    };
    const current = capturePromptFields(p);
    const base = baselineFields.get(p.identifier);
    if (base) {
      const diff = {};
      let hasDiff = false;
      for (const key of PROMPT_FIELD_WHITELIST) {
        if (current[key] !== void 0 && current[key] !== base[key]) {
          diff[key] = current[key];
          hasDiff = true;
        }
      }
      if (hasDiff) entry.fields = filterFields(diff);
    } else if (Object.keys(current).length > 0) {
      entry.fields = current;
    }
    return entry;
  });
}
function snapshotToChanges(snapshot, parentEntries, previousChanges = []) {
  const baseEnabled = new Map(parentEntries.map((p) => [p.identifier, p.enabled]));
  const baseFields = new Map(parentEntries.map((p) => [p.identifier, p.fields]));
  const previousFields = new Map(
    previousChanges.filter((c) => c.fields).map((c) => [c.identifier, c.fields])
  );
  const changes = [];
  for (const state of snapshot) {
    const baseValue = baseEnabled.get(state.identifier);
    const enabledDiff = baseValue !== void 0 && baseValue !== state.enabled;
    const base = baseFields.get(state.identifier);
    let fieldDiff;
    if (state.fields) {
      const diff = {};
      let hasDiff = false;
      for (const key of PROMPT_FIELD_WHITELIST) {
        const snapValue = state.fields[key];
        const baseValueField = base?.[key];
        if (snapValue !== void 0 && snapValue !== baseValueField) {
          diff[key] = snapValue;
          hasDiff = true;
        }
      }
      if (hasDiff) fieldDiff = diff;
    }
    const fields = state.fields !== void 0 ? fieldDiff : previousFields.get(state.identifier);
    if (enabledDiff || fields) {
      const change = { identifier: state.identifier };
      if (enabledDiff) change.enabled = state.enabled;
      if (fields) change.fields = fields;
      changes.push(change);
    }
  }
  return changes;
}
function applyProfileToPreset(preset, profile, allProfiles, opts) {
  pruneStaleOrderEntries(preset);
  if (isPromptBaseProfile(profile)) {
    applyBaseProfile(preset, profile);
  } else if (isPromptDeltaProfile(profile)) {
    const states = resolveProfilePrompts(profile, allProfiles);
    if (states.length === 0) {
      toastr.warning(L("Base profile not found, applying changes only"));
    } else {
      applyBaseProfile(preset, {
        id: profile.baseId || "parent",
        prompts: states
      });
    }
    const { missing } = applyDeltaProfile(preset, profile);
    if (opts?.showMissingToast && missing.length > 0) {
      toastr.warning(`${L("Missing prompts skipped")}: ${missing.join(", ")}`);
    }
  } else {
    const ext = preset.extensions;
    Object.assign(preset, profile.settings);
    preset.extensions = ext;
  }
}

function buildDerivedProfile(parent, name, changes = [], sampling) {
  return {
    formatVersion: 2,
    kind: "prompt_delta",
    id: newProfileId(),
    name,
    baseId: parent.id,
    changes,
    ...sampling ? { sampling } : {}
  };
}
function collectDescendantProfileIds(meta, rootId) {
  const result = [];
  const visited = /* @__PURE__ */ new Set();
  const queue = [String(rootId)];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    for (const p of meta.profiles) {
      if (isPromptDeltaProfile(p) && String(p.baseId) === current) {
        result.push(String(p.id));
        queue.push(String(p.id));
      }
    }
  }
  return result;
}
function convertV1ToBase(v1) {
  const settings = v1.settings;
  let prompts = buildBaseSnapshotDiff(settings, null);
  if (prompts.length === 0 && Array.isArray(settings.prompts) && settings.prompts.length > 0) {
    prompts = settings.prompts.filter((p) => p && typeof p.identifier === "string" && p.identifier).map((p) => ({
      identifier: p.identifier,
      enabled: p.enabled === true,
      ...Object.keys(capturePromptFields(p)).length > 0 ? { fields: capturePromptFields(p) } : {}
    }));
  }
  const sampling = {};
  for (const key of SAMPLING_KEYS) {
    const value = settings[key];
    if (value !== void 0) sampling[key] = value;
  }
  const extra = captureExtra(settings);
  const jb = settings["jailbreak"];
  if (typeof jb === "string" && jb.length > 0) {
    const jbEntry = prompts.find((p) => p.identifier === "jailbreak");
    if (jbEntry) {
      jbEntry.fields = { ...jbEntry.fields ?? {}, content: jb };
      if (extra) delete extra["jailbreak"];
    }
  }
  return {
    formatVersion: 2,
    kind: "prompt_base",
    id: v1.id || newProfileId(),
    name: v1.name,
    prompts,
    ...Object.keys(sampling).length > 0 ? { sampling } : {},
    ...extra ? { extra } : {}
  };
}

function chooseProfileSaveTarget() {
  return chooseFromOptions(L("Save changes to"), [
    [L("Update current profile"), "update"],
    [L("Create new subprofile"), "create"]
  ]);
}
function chooseProfileExportAction() {
  return chooseFromOptions(L("Export configuration"), [
    [L("Export"), "profile"],
    [L("Export with branch chain"), "tree"]
  ]);
}
async function chooseFromOptions(title, options) {
  const container = $('<div class="preset_cards_save_choice"></div>');
  container.append($('<div class="preset_cards_save_choice_title"></div>').text(title));
  const buttons = $('<div class="preset_cards_save_choice_actions"></div>');
  for (const [label, value] of options) {
    buttons.append($('<button class="menu_button"></button>').text(label).on("click", function() {
      resolveChoice(value);
    }));
  }
  buttons.append($('<button class="menu_button"></button>').text(L("Cancel")).on("click", function() {
    resolveChoice(null);
  }));
  container.append(buttons);
  let resolver;
  let settled = false;
  const promise = new Promise((r) => {
    resolver = r;
  });
  function resolveChoice(v) {
    if (settled) return;
    settled = true;
    resolver(v);
    $(container).closest(".popup").find(".popup-controls .menu_button").click();
  }
  callGenericPopup(container, POPUP_TYPE.TEXT, "", {
    okButton: false,
    cancelButton: "",
    onClose: () => {
      if (!settled) {
        settled = true;
        resolver(null);
      }
    }
  });
  return promise;
}
function buildProfileExportData(profile, meta) {
  const base = meta.defaultSnapshot && meta.defaultSnapshot.length > 0 ? meta.defaultSnapshot : void 0;
  if (isPromptBaseProfile(profile)) {
    return JSON.stringify({
      kind: profile.kind,
      formatVersion: profile.formatVersion,
      prompts: profile.prompts,
      ...profile.sampling ? { sampling: profile.sampling } : {},
      ...profile.extra ? { extra: profile.extra } : {},
      ...base ? { defaultSnapshot: base, defaultSnapshotLocked: meta.defaultSnapshotLocked === true } : {}
    }, null, 4);
  }
  if (isPromptDeltaProfile(profile)) {
    const resolvedState = resolveProfilePrompts(profile, meta.profiles);
    const fileBaselineStates = defaultSnapshotStates(base);
    const changesVsFileBaseline = fileBaselineStates.length ? changesRelativeToBaseline(resolvedState, fileBaselineStates) : profile.changes;
    return JSON.stringify({
      kind: profile.kind,
      formatVersion: profile.formatVersion,
      baseId: profile.baseId,
      base: {
        name: "Imported Parent",
        prompts: resolvedState
      },
      changes: changesVsFileBaseline,
      ...profile.sampling ? { sampling: profile.sampling } : {},
      ...profile.extra ? { extra: profile.extra } : {},
      ...base ? { defaultSnapshot: base, defaultSnapshotLocked: meta.defaultSnapshotLocked === true } : {}
    }, null, 4);
  }
  return JSON.stringify(profile.settings, null, 4);
}
function buildTreeExportData(meta, targetId) {
  const profiles = meta.profiles.filter((p) => isPromptBaseProfile(p) || isPromptDeltaProfile(p));
  const childrenByParent = /* @__PURE__ */ new Map();
  for (const p of profiles) {
    if (isPromptDeltaProfile(p)) {
      const list = childrenByParent.get(p.baseId) ?? [];
      list.push(p);
      childrenByParent.set(p.baseId, list);
    }
  }
  const ordered = [];
  const visited = /* @__PURE__ */ new Set();
  const visit = (p) => {
    if (visited.has(p.id)) return;
    if (isPromptDeltaProfile(p)) {
      const parent = getProfile(meta, p.baseId);
      if (parent && (isPromptBaseProfile(parent) || isPromptDeltaProfile(parent))) visit(parent);
    }
    visited.add(p.id);
    ordered.push(p);
    for (const child of childrenByParent.get(p.id) ?? []) visit(child);
  };
  for (const p of profiles) {
    if (isPromptBaseProfile(p)) visit(p);
  }
  for (const p of profiles) {
    if (!visited.has(p.id)) visit(p);
  }
  const exported = ordered.map((p) => isPromptBaseProfile(p) ? { kind: p.kind, id: p.id, name: p.name, prompts: p.prompts, ...p.sampling ? { sampling: p.sampling } : {}, ...p.extra ? { extra: p.extra } : {} } : { kind: p.kind, id: p.id, name: p.name, baseId: p.baseId, changes: p.changes, ...p.sampling ? { sampling: p.sampling } : {}, ...p.extra ? { extra: p.extra } : {} });
  const payload = {
    kind: "prompt_tree",
    formatVersion: 2,
    profiles: exported,
    // 附带预设 defaultSnapshot（出厂基线）与 locked 标记：导入后 reset 仍可还原出厂值
    ...meta.defaultSnapshot && meta.defaultSnapshot.length > 0 ? { defaultSnapshot: meta.defaultSnapshot, defaultSnapshotLocked: meta.defaultSnapshotLocked === true } : {},
    ...targetId ? { targetId } : {}
  };
  return JSON.stringify(payload, null, 4);
}
function warnV1ExcludedFromTreeExport(meta) {
  if (meta.profiles.some((p) => !isPromptBaseProfile(p) && !isPromptDeltaProfile(p))) {
    toastr.warning(L("Legacy v1 profiles are not included in the tree export"));
  }
}
function buildBridgeBase(fileBaseline, localBaseline, name, id) {
  const xById = /* @__PURE__ */ new Map();
  if (localBaseline) {
    for (const e of localBaseline) xById.set(e.identifier, e);
  }
  const prompts = fileBaseline.flatMap((e) => {
    if (typeof e.enabled !== "boolean") return [];
    const entry = { identifier: e.identifier, enabled: e.enabled };
    const bFields = e.originalFields ?? {};
    const x = xById.get(e.identifier);
    const diff = {};
    let hasDiff = false;
    if (x) {
      const xFields = x.originalFields ?? {};
      for (const key of PROMPT_FIELD_WHITELIST) {
        if (bFields[key] !== void 0 && bFields[key] !== xFields[key]) {
          diff[key] = bFields[key];
          hasDiff = true;
        }
      }
    } else {
      for (const key of PROMPT_FIELD_WHITELIST) {
        if (bFields[key] !== void 0) {
          diff[key] = bFields[key];
          hasDiff = true;
        }
      }
    }
    if (hasDiff) entry.fields = diff;
    return [entry];
  });
  return { formatVersion: 2, kind: "prompt_base", id, name, prompts };
}
function defaultSnapshotStates(snapshot) {
  return (snapshot ?? []).map((entry) => ({
    identifier: entry.identifier,
    enabled: entry.enabled,
    fields: entry.originalFields
  }));
}
function changesRelativeToBaseline(entries, fileBaselineStates) {
  const knownEnabledBaseline = fileBaselineStates.filter(
    (entry) => typeof entry.enabled === "boolean"
  );
  const changes = snapshotToChanges(entries, knownEnabledBaseline, []);
  const baselineById = new Map(fileBaselineStates.map((entry) => [entry.identifier, entry]));
  for (const entry of entries) {
    const baseline = baselineById.get(entry.identifier);
    if (typeof baseline?.enabled === "boolean") continue;
    const change = { identifier: entry.identifier, enabled: entry.enabled };
    const fullFields = { ...baseline?.fields ?? {}, ...entry.fields ?? {} };
    if (Object.keys(fullFields).length > 0) {
      change.fields = fullFields;
    }
    const existing = changes.find((c) => c.identifier === entry.identifier);
    if (existing) {
      existing.enabled = change.enabled;
      if (change.fields) existing.fields = change.fields;
    } else {
      changes.push(change);
    }
  }
  return changes;
}
function mergeImportedProfiles(parsed, existing, profileName, localDefaultSnapshot) {
  const profiles = [...existing];
  const warnings = [];
  const usedIds = new Set(profiles.map((p) => p.id));
  const freshId = () => {
    let id = newProfileId();
    while (usedIds.has(id)) id = newProfileId();
    usedIds.add(id);
    return id;
  };
  const newId = freshId();
  const fileBaseline = Array.isArray(parsed?.defaultSnapshot) && parsed.defaultSnapshot.every((d) => d && typeof d === "object" && typeof d.identifier === "string" && (d.enabled === void 0 || typeof d.enabled === "boolean") && (d.originalFields === void 0 || d.originalFields === null || typeof d.originalFields === "object")) ? parsed.defaultSnapshot : void 0;
  const fileBaselineStates = defaultSnapshotStates(fileBaseline);
  const bridgeBase = fileBaseline && fileBaseline.length > 0 ? buildBridgeBase(fileBaseline, localDefaultSnapshot, profileName, freshId()) : void 0;
  if (bridgeBase) profiles.push(bridgeBase);
  if (parsed && parsed.kind === "prompt_tree" && Array.isArray(parsed.profiles)) {
    const idMap = /* @__PURE__ */ new Map();
    const targetId = typeof parsed.targetId === "string" ? parsed.targetId : void 0;
    let unresolved = false;
    for (const entry of parsed.profiles) {
      if (!entry) continue;
      if (entry.kind === "prompt_base" && Array.isArray(entry.prompts)) {
        if (bridgeBase) {
          const baseNewId = freshId();
          if (entry.id !== void 0) idMap.set(String(entry.id), baseNewId);
          profiles.push({
            formatVersion: 2,
            kind: "prompt_delta",
            id: baseNewId,
            name: entry.name || profileName,
            baseId: bridgeBase.id,
            changes: changesRelativeToBaseline(entry.prompts, fileBaselineStates),
            ...entry.sampling ? { sampling: entry.sampling } : {},
            ...entry.extra ? { extra: entry.extra } : {}
          });
        } else {
          const existing2 = profiles.find((b) => isPromptBaseProfile(b) && b.name === (entry.name || profileName) && b.prompts.length === entry.prompts.length && b.prompts.every((e, i) => e.identifier === entry.prompts[i].identifier && e.enabled === entry.prompts[i].enabled && promptFieldsEqual(e.fields ?? {}, entry.prompts[i].fields ?? {})) && JSON.stringify(b.sampling ?? null) === JSON.stringify(entry.sampling ?? null) && JSON.stringify(b.extra ?? null) === JSON.stringify(entry.extra ?? null));
          if (existing2) {
            if (entry.id !== void 0) idMap.set(String(entry.id), existing2.id);
          } else {
            const baseNewId = freshId();
            profiles.push({
              formatVersion: 2,
              kind: "prompt_base",
              id: baseNewId,
              name: entry.name || profileName,
              prompts: entry.prompts,
              ...entry.sampling ? { sampling: entry.sampling } : {},
              ...entry.extra ? { extra: entry.extra } : {}
            });
            if (entry.id !== void 0) idMap.set(String(entry.id), baseNewId);
          }
        }
      } else if (entry.kind === "prompt_delta" && Array.isArray(entry.changes)) {
        const isTarget = targetId !== void 0 ? entry.id !== void 0 && String(entry.id) === targetId : entry === parsed.profiles[parsed.profiles.length - 1];
        const rawBaseId = typeof entry.baseId === "string" ? entry.baseId : "";
        const resolvedBaseId = rawBaseId ? idMap.get(rawBaseId) : void 0;
        if (rawBaseId && !resolvedBaseId) unresolved = true;
        const deltaNewId = freshId();
        if (entry.id !== void 0) idMap.set(String(entry.id), deltaNewId);
        profiles.push({
          formatVersion: 2,
          kind: "prompt_delta",
          id: deltaNewId,
          name: isTarget ? profileName : entry.name || profileName,
          baseId: resolvedBaseId || rawBaseId,
          changes: entry.changes,
          ...entry.sampling ? { sampling: entry.sampling } : {},
          ...entry.extra ? { extra: entry.extra } : {}
        });
      }
    }
    if (unresolved) {
      warnings.push(L("Base profile not found for this imported derived configuration"));
    }
  } else if (parsed && parsed.kind === "prompt_base" && Array.isArray(parsed.prompts)) {
    if (bridgeBase) {
      profiles.push({
        formatVersion: 2,
        kind: "prompt_delta",
        id: newId,
        name: profileName,
        baseId: bridgeBase.id,
        changes: changesRelativeToBaseline(parsed.prompts, fileBaselineStates),
        ...parsed.sampling ? { sampling: parsed.sampling } : {},
        ...parsed.extra ? { extra: parsed.extra } : {}
      });
    } else {
      profiles.push({
        formatVersion: 2,
        kind: "prompt_base",
        id: newId,
        name: profileName,
        prompts: parsed.prompts,
        ...parsed.sampling ? { sampling: parsed.sampling } : {},
        ...parsed.extra ? { extra: parsed.extra } : {}
      });
    }
  } else if (parsed && parsed.kind === "prompt_delta" && Array.isArray(parsed.changes)) {
    if (bridgeBase) {
      const baseStates = Array.isArray(parsed.base?.prompts) ? parsed.base.prompts : void 0;
      const changesVsFileBaseline = baseStates ? changesRelativeToBaseline(baseStates, fileBaselineStates) : parsed.changes;
      profiles.push({
        formatVersion: 2,
        kind: "prompt_delta",
        id: newId,
        name: profileName,
        baseId: bridgeBase.id,
        changes: changesVsFileBaseline,
        ...parsed.sampling ? { sampling: parsed.sampling } : {},
        ...parsed.extra ? { extra: parsed.extra } : {}
      });
    } else {
      let baseId = "";
      const importedBase = parsed.base;
      if (importedBase && Array.isArray(importedBase.prompts)) {
        const existing2 = profiles.find((b) => isPromptBaseProfile(b) && b.name === (importedBase.name || profileName) && b.prompts.length === importedBase.prompts.length && b.prompts.every((e, i) => e.identifier === importedBase.prompts[i].identifier && e.enabled === importedBase.prompts[i].enabled && promptFieldsEqual(e.fields ?? {}, importedBase.prompts[i].fields ?? {})) && JSON.stringify(b.sampling ?? null) === JSON.stringify(importedBase.sampling ?? null) && JSON.stringify(b.extra ?? null) === JSON.stringify(importedBase.extra ?? null));
        if (existing2) {
          baseId = existing2.id;
        } else {
          const baseIdNew = freshId();
          profiles.push({
            formatVersion: 2,
            kind: "prompt_base",
            id: baseIdNew,
            name: importedBase.name || profileName,
            prompts: importedBase.prompts,
            ...importedBase.sampling ? { sampling: importedBase.sampling } : {},
            ...importedBase.extra ? { extra: importedBase.extra } : {}
          });
          baseId = baseIdNew;
        }
      } else {
        baseId = typeof parsed.baseId === "string" ? parsed.baseId : "";
      }
      profiles.push({
        formatVersion: 2,
        kind: "prompt_delta",
        id: newId,
        name: profileName,
        baseId,
        changes: parsed.changes,
        ...parsed.sampling ? { sampling: parsed.sampling } : {},
        ...parsed.extra ? { extra: parsed.extra } : {}
      });
      const baseExists = profiles.some((b) => isPromptBaseProfile(b) && b.id === baseId);
      if (baseId && !baseExists) {
        warnings.push(L("Base profile not found for this imported derived configuration"));
      }
    }
  } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.prompts)) {
    profiles.push(convertV1ToBase({ id: newId, name: profileName, settings: parsed }));
  } else {
    throw new Error("Imported configuration is not a valid preset snapshot (missing prompts array)");
  }
  return { profiles, warnings };
}

const STORAGE_KEY = "preset_cards.active_profile";
let current;
function initActiveProfile() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.presetName === "string" && typeof parsed.profileId === "string") {
        current = parsed;
        return;
      }
    }
  } catch {
  }
  try {
    const activeName = oai_settings?.preset_settings_openai;
    if (typeof activeName === "string" && activeName) {
      const idx = openai_setting_names?.[activeName];
      const preset = idx !== void 0 ? openai_settings[idx] : void 0;
      const legacyId = preset?.extensions?.[EXTENSION_KEY]?.activeProfileId;
      if (typeof legacyId === "string") {
        current = { presetName: activeName, profileId: legacyId };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
      }
    }
  } catch {
    current = void 0;
  }
}
function getActiveProfile() {
  return current;
}
function setActiveProfile(ref) {
  current = ref;
  try {
    if (ref) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ref));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
  }
}

function buildProfileForest(profiles) {
  const childrenByParent = /* @__PURE__ */ new Map();
  const nodeById = /* @__PURE__ */ new Map();
  for (const p of profiles) {
    nodeById.set(String(p.id), { profile: p, children: [] });
  }
  for (const p of profiles) {
    if (isPromptDeltaProfile(p)) {
      const parent = nodeById.get(String(p.baseId));
      if (parent && (isPromptBaseProfile(parent.profile) || isPromptDeltaProfile(parent.profile))) {
        const list = childrenByParent.get(String(p.baseId)) ?? [];
        list.push(nodeById.get(String(p.id)));
        childrenByParent.set(String(p.baseId), list);
        parent.children = list;
      }
    }
  }
  const roots = [];
  for (const p of profiles) {
    if (isPromptBaseProfile(p) || !isPromptDeltaProfile(p)) {
      roots.push(nodeById.get(String(p.id)));
      continue;
    }
    const parent = nodeById.get(String(p.baseId));
    if (!parent || !isPromptBaseProfile(parent.profile) && !isPromptDeltaProfile(parent.profile)) {
      roots.push(nodeById.get(String(p.id)));
    }
  }
  const reached = /* @__PURE__ */ new Set();
  const mark = (node) => {
    if (reached.has(String(node.profile.id))) return;
    reached.add(String(node.profile.id));
    for (const child of node.children) mark(child);
  };
  for (const root of roots) mark(root);
  for (const p of profiles) {
    if (!reached.has(String(p.id))) {
      roots.push(nodeById.get(String(p.id)));
      reached.add(String(p.id));
    }
  }
  return roots;
}
function buildProfileNested(forest) {
  const build = (node, depth, visited2) => {
    const id = String(node.profile.id);
    if (visited2.has(id)) return null;
    visited2.add(id);
    const children = [];
    for (const child of node.children) {
      const built = build(child, depth + 1, visited2);
      if (built) children.push(built);
    }
    return { profile: node.profile, depth, children };
  };
  const visited = /* @__PURE__ */ new Set();
  const roots = [];
  for (const root of forest) {
    const built = build(root, 0, visited);
    if (built) roots.push(built);
  }
  return roots;
}

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? "…" + str.slice(-39) : str;
}
function buildProfileOrderCtx(preset, isActive) {
  const orderIndex = /* @__PURE__ */ new Map();
  let orderLength = 0;
  if (isActive && Array.isArray(preset.prompt_order)) {
    const orderList = findOrderList(preset, resolvePromptOrderTarget());
    if (Array.isArray(orderList?.order)) {
      orderLength = orderList.order.length;
      orderList.order.forEach((o, i) => {
        if (o && typeof o.identifier === "string") orderIndex.set(o.identifier, i);
      });
    }
  }
  return { orderIndex, orderLength };
}
const FORCE_TOGGLE_MARKERS = /* @__PURE__ */ new Set([
  "charDescription",
  "charPersonality",
  "scenario",
  "personaDescription",
  "worldInfoBefore",
  "worldInfoAfter",
  "main",
  "chatHistory",
  "dialogueExamples"
]);
function buildProfileEntries(profile, meta, preset, orderCtx = { orderIndex: /* @__PURE__ */ new Map(), orderLength: 0 }) {
  if (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile)) return [];
  const promptNames = /* @__PURE__ */ new Map();
  const promptLookup = /* @__PURE__ */ new Map();
  if (Array.isArray(preset.prompts)) {
    for (const p of preset.prompts) {
      if (p && typeof p.identifier === "string" && p.identifier) {
        promptLookup.set(p.identifier, p);
        if (typeof p.name === "string") {
          promptNames.set(p.identifier, p.name);
        }
      }
    }
  }
  const resolved = resolveProfilePrompts(profile, meta.profiles, /* @__PURE__ */ new Set());
  const sorted = [...resolved].sort((a, b) => {
    const ia = orderCtx.orderIndex.get(a.identifier);
    const ib = orderCtx.orderIndex.get(b.identifier);
    if (ia !== void 0 && ib !== void 0) return ia - ib;
    if (ia !== void 0) return -1;
    if (ib !== void 0) return 1;
    return 0;
  });
  return sorted.map((e) => {
    const prompt = promptLookup.get(e.identifier);
    const hasFields = !!e.fields && Object.keys(e.fields).length > 0;
    const orderIdx = orderCtx.orderIndex.get(e.identifier);
    return {
      identifier: e.identifier,
      name: e.fields?.name ?? promptNames.get(e.identifier) ?? e.identifier,
      role: e.fields?.role ?? prompt?.role ?? "system",
      index: orderIdx !== void 0 ? String(orderIdx + 1).padStart(2, "0") : void 0,
      content: e.fields?.content ?? prompt?.content,
      enabled: e.enabled,
      hasFields,
      // hasFields 基于 resolveProfilePrompts（递归合并父链）→ 含继承自父 profile 的 fields；
      // hasPersistentDiff 仅本 profile 自身差异：base 取自身 prompts[].fields（= hasFields），
      // delta 取自身 changes 里的 fields/enabled，父链继承的差异不属于本 profile。
      // 故「子 delta 有继承值差异 → 有铅笔（hasFields）无琥珀（hasPersistentDiff）」为预期行为。
      hasPersistentDiff: isPromptDeltaProfile(profile) ? profile.changes.some((c) => c.identifier === e.identifier && (c.enabled !== void 0 || c.fields && Object.keys(c.fields).length > 0)) : hasFields,
      // base 的 fields 即自身值变更；delta 需自身 changes 里有 fields（父链继承的不可由本 profile 清除）
      clearable: isPromptDeltaProfile(profile) ? profile.changes.some((c) => c.identifier === e.identifier && c.fields && Object.keys(c.fields).length > 0) : hasFields,
      // system_prompt / marker 条目不渲染编辑入口；预设中缺失的条目也无法编辑
      editable: !!prompt && !prompt.system_prompt && !prompt.marker,
      // 开关对齐 ST isPromptToggleAllowed：普通 prompt 均可开关；marker 仅白名单内的可开关
      toggleable: !!prompt && (!prompt.marker || FORCE_TOGGLE_MARKERS.has(prompt.identifier)),
      // 顺序编辑仅对活动预设开放（重排非活动预设的 prompt_order 无意义）
      orderable: orderIdx !== void 0
    };
  });
}
function buildPresetList() {
  const currentPresetName = oai_settings.preset_settings_openai;
  const presets = [];
  const activeRef = getActiveProfile();
  for (const [name, index] of Object.entries(openai_setting_names)) {
    const preset = openai_settings[index];
    if (!preset) continue;
    const isActive = name === currentPresetName;
    const orderCtx = buildProfileOrderCtx(preset, isActive);
    const source = String(preset["chat_completion_source"] ?? "");
    const sourceLabel = SOURCE_LABELS[source] || "";
    const modelKey = MODEL_KEYS[source] || "";
    const modelName = modelKey ? truncate(String(preset[modelKey] ?? ""), 40) : "";
    let sourceAndModel = sourceLabel;
    if (modelName) sourceAndModel += " · " + modelName;
    const logoPath = SOURCE_LOGO_MAP[source] || "";
    const meta = readMeta(preset);
    const decorate = (node) => {
      const p = node.profile;
      let entries = [];
      if (isPromptBaseProfile(p) || isPromptDeltaProfile(p)) {
        entries = buildProfileEntries(p, meta, preset, orderCtx);
      }
      const row = {
        id: String(p.id),
        name: p.name,
        isV1: !isPromptBaseProfile(p) && !isPromptDeltaProfile(p),
        depth: node.depth,
        entries,
        isActiveProfile: !!activeRef && activeRef.presetName === name && activeRef.profileId === String(p.id),
        childCount: node.children.length
      };
      return { ...row, children: node.children.map(decorate) };
    };
    const forest = buildProfileForest(Array.isArray(meta.profiles) ? meta.profiles : []);
    const profiles = buildProfileNested(forest).map(decorate);
    const modelChips = meta.models.map((mid) => {
      const def = AVAILABLE_MODELS.find((m) => m.id === mid);
      return def ? { label: def.label, logo: LOGO_BASE + def.logo } : { label: mid, logo: "" };
    });
    presets.push({
      name,
      index,
      isActive,
      temperature: preset["temperature"] != null ? String(preset["temperature"]) : "",
      topP: preset["top_p"] != null ? String(preset["top_p"]) : "",
      topK: preset["top_k"] != null ? String(preset["top_k"]) : "",
      contextTokens: Number(preset["openai_max_context"] || 0),
      maxTokens: Number(preset["openai_max_tokens"] || 0),
      streaming: !!preset["stream_openai"],
      sourceAndModel,
      logoPath,
      description: meta.description,
      bgImage: meta.bgImage,
      modelChips,
      profiles
    });
  }
  presets.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return presets;
}
function getCardsTemplateContext() {
  return {
    presets: buildPresetList(),
    i18n: {
      searchPlaceholder: L("Search presets..."),
      multiSelect: L("Multi-Select"),
      batchDelete: L("Batch Delete"),
      importPreset: L("Import Preset"),
      conciseMode: L("Concise Mode"),
      clearCache: L("Clear Cache"),
      configurations: L("Configurations"),
      addBaseConfig: L("Save Base Profile"),
      loadConfig: L("Load configuration"),
      exportConfig: L("Export configuration"),
      importConfig: L("Import configuration"),
      exportAll: L("Export all configurations"),
      edit: L("Edit"),
      delete: L("Delete"),
      derive: L("Derive Profile"),
      resetProfile: L("Reset to parent")
    }
  };
}

const CACHE_DB_NAME = "PresetCardsCache";
const CACHE_STORE_NAME = "images";
let cacheDb = null;
const COOLDOWN_MS = 5 * 60 * 1e3;
const MAX_RETRIES = 3;
const URL_CACHE = /* @__PURE__ */ new Map();
const FAILED_URLS = /* @__PURE__ */ new Map();
const CREATED_OBJECT_URLS = /* @__PURE__ */ new Set();
function trackObjectURL(url) {
  if (url.startsWith("blob:")) CREATED_OBJECT_URLS.add(url);
  return url;
}
function initCacheDb() {
  return new Promise((resolve) => {
    if (cacheDb) return resolve(cacheDb);
    const request = indexedDB.open(CACHE_DB_NAME, 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
        db.createObjectStore(CACHE_STORE_NAME);
      }
    };
    request.onsuccess = (e) => {
      cacheDb = e.target.result;
      resolve(cacheDb);
    };
    request.onerror = () => {
      console.warn("preset-cards: Failed to open IndexedDB for caching.");
      resolve(null);
    };
  });
}
function getCachedImageURL(url) {
  if (!url) return Promise.resolve("");
  if (url.startsWith("data:") || url.startsWith("blob:")) return Promise.resolve(url);
  const cached = URL_CACHE.get(url);
  if (cached) return cached;
  const failed = FAILED_URLS.get(url);
  if (failed) {
    const now = Date.now();
    if (now - failed.lastFailedAt < COOLDOWN_MS) return Promise.resolve(url);
    if (failed.count >= MAX_RETRIES) return Promise.resolve(url);
  }
  const promise = (async () => {
    const db = await initCacheDb();
    if (!db) return url;
    return new Promise((resolve) => {
      const tx = db.transaction(CACHE_STORE_NAME, "readonly");
      const store = tx.objectStore(CACHE_STORE_NAME);
      const req = store.get(url);
      req.onsuccess = async () => {
        if (req.result) {
          resolve(trackObjectURL(URL.createObjectURL(req.result)));
        } else {
          try {
            const response = await fetch(url, { mode: "cors" });
            if (!response.ok) throw new Error("Network response was not ok");
            const blob = await response.blob();
            FAILED_URLS.delete(url);
            const writeTx = db.transaction(CACHE_STORE_NAME, "readwrite");
            writeTx.objectStore(CACHE_STORE_NAME).put(blob, url);
            resolve(trackObjectURL(URL.createObjectURL(blob)));
          } catch (err) {
            console.warn("preset-cards: CORS or network error caching image, falling back to original URL.", err);
            const prev = FAILED_URLS.get(url);
            FAILED_URLS.set(url, { count: prev ? prev.count + 1 : 1, lastFailedAt: Date.now() });
            URL_CACHE.delete(url);
            resolve(url);
          }
        }
      };
      req.onerror = () => resolve(url);
    });
  })();
  URL_CACHE.set(url, promise);
  return promise;
}
function applyCachedBackgrounds(container) {
  container.find(".preset_card_bg_image").each(function() {
    const url = $(this).data("bg-url");
    if (url && !$(this).css("background-image").includes("url(")) {
      getCachedImageURL(url).then((cachedUrl) => {
        $(this).css("background-image", `url('${cachedUrl}')`);
      });
    }
  });
}
async function clearImageCache() {
  URL_CACHE.clear();
  FAILED_URLS.clear();
  for (const url of CREATED_OBJECT_URLS) URL.revokeObjectURL(url);
  CREATED_OBJECT_URLS.clear();
  const db = await initCacheDb();
  if (!db) return false;
  return new Promise((resolve) => {
    const tx = db.transaction(CACHE_STORE_NAME, "readwrite");
    const store = tx.objectStore(CACHE_STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
  });
}

async function openEditModal(presetName, presetIndex, onSaved) {
  const preset = openai_settings[presetIndex];
  if (!preset) return;
  const meta = readMeta(preset);
  const availableModels = AVAILABLE_MODELS.map((m) => ({
    ...m,
    logo: LOGO_BASE + m.logo,
    selected: meta.models.includes(m.id)
  }));
  const html = await renderExtensionTemplateAsync(EXTENSION_NAME, "edit", {
    presetName,
    description: meta.description,
    bgImage: meta.bgImage,
    availableModels,
    sampling: {
      temperature: preset["temperature"] != null ? String(preset["temperature"]) : "",
      topP: preset["top_p"] != null ? String(preset["top_p"]) : "",
      topK: preset["top_k"] != null ? String(preset["top_k"]) : "",
      contextTokens: preset["openai_max_context"] != null ? String(preset["openai_max_context"]) : "",
      maxTokens: preset["openai_max_tokens"] != null ? String(preset["openai_max_tokens"]) : "",
      streaming: !!preset["stream_openai"]
    },
    i18n: {
      descTitle: L("Description"),
      descPlaceholder: L("Add a short description for this preset..."),
      modelsTitle: L("Applicable Models"),
      bgImageTitle: L("Background Image URL"),
      bgImagePlaceholder: L("e.g., https://example.com/bg.jpg"),
      samplingTitle: L("Sampling"),
      contextTitle: L("Context"),
      tokensTitle: L("Tokens"),
      streamTitle: L("Streaming")
    }
  });
  const dialog = $(html);
  dialog.find(".preset_edit_model_option").on("click", function() {
    $(this).toggleClass("active");
  });
  const result = await callGenericPopup(dialog, POPUP_TYPE.CONFIRM, "", {
    okButton: t`Save`,
    cancelButton: t`Cancel`,
    allowVerticalScrolling: true
  });
  if (result !== POPUP_RESULT.AFFIRMATIVE) return;
  const newDesc = dialog.find("#preset_edit_desc").val()?.toString().trim() || "";
  const newBgImage = dialog.find("#preset_edit_bg_image").val()?.toString().trim() || "";
  const newModels = dialog.find(".preset_edit_model_option.active").map(function() {
    return $(this).data("model-id");
  }).get();
  const toNumOrUndef = (sel) => {
    const raw = dialog.find(sel).val()?.toString().trim() ?? "";
    if (raw === "") return void 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : void 0;
  };
  const temp = toNumOrUndef("#preset_edit_temp");
  const topP = toNumOrUndef("#preset_edit_top_p");
  const topK = toNumOrUndef("#preset_edit_top_k");
  const context = toNumOrUndef("#preset_edit_context");
  const maxTokens = toNumOrUndef("#preset_edit_max_tokens");
  const streaming = dialog.find("#preset_edit_stream").is(":checked");
  if (temp !== void 0) preset["temperature"] = temp;
  if (topP !== void 0) preset["top_p"] = topP;
  if (topK !== void 0) preset["top_k"] = topK;
  if (context !== void 0) preset["openai_max_context"] = context;
  if (maxTokens !== void 0) preset["openai_max_tokens"] = maxTokens;
  preset["stream_openai"] = streaming;
  await saveMeta(presetName, presetIndex, { description: newDesc, models: newModels, bgImage: newBgImage, profiles: meta.profiles, defaultSnapshot: meta.defaultSnapshot, defaultSnapshotLocked: meta.defaultSnapshotLocked, defaultExtra: meta.defaultExtra });
  toastr.success(t`Preset updated`);
  if (onSaved) onSaved();
}
function buildPromptEditForm(preset, identifier, current) {
  const prompt = findPromptInPreset(preset, identifier);
  if (!prompt) {
    return {
      container: $('<div class="preset_cards_prompt_edit_form"></div>'),
      collectFields: () => null
    };
  }
  const isMarker = !!prompt.marker;
  const nameVal = current?.name !== void 0 ? current.name : prompt.name ?? "";
  const roleVal = current?.role !== void 0 ? current.role : prompt.role ?? "system";
  const contentVal = current?.content !== void 0 ? current.content : prompt.content ?? "";
  const positionVal = current?.injection_position !== void 0 ? current.injection_position : prompt.injection_position ?? 0;
  const depthVal = current?.injection_depth !== void 0 ? current.injection_depth : prompt.injection_depth ?? 4;
  const container = $('<div class="preset_cards_prompt_edit_form"></div>');
  container.append($('<div class="preset_cards_prompt_edit_title"></div>').text(L("Edit prompt")));
  if (isMarker) {
    container.append($('<div class="preset_cards_prompt_edit_marker_notice"></div>').text(L("This is a marker prompt. Its content is managed by SillyTavern and cannot be edited here.")));
  }
  const nameWrap = $('<div class="preset_edit_field"></div>');
  nameWrap.append($("<label></label>").text(L("Name")));
  const nameInput = $('<input type="text">').val(nameVal);
  nameWrap.append(nameInput);
  const rowWrap = $('<div class="preset_cards_prompt_edit_row"></div>');
  const roleWrap = $('<div class="preset_edit_field"></div>');
  roleWrap.append($("<label></label>").text(L("Role")));
  const roleSelect = $('<select class="text_pole"></select>');
  for (const [value, label] of [["system", L("System")], ["user", L("User")], ["assistant", L("AI Assistant")]]) {
    const option = $("<option></option>").attr("value", value).text(label);
    if (value === roleVal) option.attr("selected", "selected");
    roleSelect.append(option);
  }
  roleWrap.append(roleSelect);
  const positionWrap = $('<div class="preset_edit_field"></div>');
  positionWrap.append($("<label></label>").text(L("Position")));
  const positionSelect = $('<select class="text_pole"></select>');
  for (const [value, label] of [["0", L("Relative")], ["1", L("In-chat")], ["2", L("In Chat Absolute Depth")]]) {
    const option = $("<option></option>").attr("value", value).text(label);
    if (value === String(positionVal)) option.attr("selected", "selected");
    positionSelect.append(option);
  }
  positionWrap.append(positionSelect);
  rowWrap.append(roleWrap);
  rowWrap.append(positionWrap);
  const depthWrap = $('<div class="preset_edit_field preset_cards_prompt_edit_depth" style="display:none;"></div>');
  depthWrap.append($("<label></label>").text(L("Injection Depth")));
  const depthInput = $('<input type="number" min="1" step="1">').val(depthVal);
  depthWrap.append(depthInput);
  positionSelect.on("change", function() {
    depthWrap.toggle(Number($(this).val()) === 2);
  });
  depthWrap.toggle(positionVal === 2);
  const contentWrap = $('<div class="preset_edit_field"></div>');
  contentWrap.append($("<label></label>").text(L("Content")));
  const contentInput = $("<textarea></textarea>").val(contentVal);
  if (isMarker) {
    contentInput.prop("disabled", true);
  }
  contentWrap.append(contentInput);
  container.append(nameWrap);
  container.append(rowWrap);
  container.append(depthWrap);
  container.append(contentWrap);
  const collectFields = () => {
    const fields = {};
    const role = String(roleSelect.val() ?? "system");
    const name = String(nameInput.val() ?? "");
    const content = String(contentInput.val() ?? "");
    const position = Number(positionSelect.val() ?? 0);
    const depthRaw = String(depthInput.val() ?? depthVal);
    const depth = depthRaw === "" ? NaN : Number(depthRaw);
    if (role !== roleVal) fields.role = role;
    if (name !== nameVal) fields.name = name;
    if (!isMarker && content !== contentVal) fields.content = content;
    if (position !== positionVal) fields.injection_position = position;
    if (position === 2 && Number.isFinite(depth) && depth !== depthVal) fields.injection_depth = depth;
    return Object.keys(fields).length > 0 ? fields : null;
  };
  return { container, collectFields };
}

function bufferPrefix(name) {
  return `${name.length}:${name}:`;
}
function bufferKey(name, identifier) {
  return `${bufferPrefix(name)}${identifier}`;
}
function clearBufferedForName(name, sessionEdits, pendingToggles) {
  const prefix = bufferPrefix(name);
  for (const key of [...sessionEdits.keys()]) {
    if (key.startsWith(prefix)) sessionEdits.delete(key);
  }
  for (const key of [...pendingToggles.keys()]) {
    if (key.startsWith(prefix)) pendingToggles.delete(key);
  }
}
function editedIdentifiersForName(name, sessionEdits) {
  const prefix = bufferPrefix(name);
  const ids = /* @__PURE__ */ new Set();
  for (const key of sessionEdits.keys()) {
    if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
  }
  return ids;
}
function applyBufferedEdits(preset, name, sessionEdits, pendingToggles) {
  const missing = [];
  const seen = /* @__PURE__ */ new Set();
  const prefix = bufferPrefix(name);
  for (const [key, enabled] of pendingToggles) {
    if (!key.startsWith(prefix)) continue;
    const identifier = key.slice(prefix.length);
    if (!applyEntryState(preset, identifier, enabled)) {
      seen.add(identifier);
      missing.push(identifier);
    }
  }
  for (const [key, session] of sessionEdits) {
    if (!key.startsWith(prefix)) continue;
    const identifier = key.slice(prefix.length);
    const prompt = findPromptInPreset(preset, identifier);
    if (!prompt) {
      if (!seen.has(identifier)) {
        seen.add(identifier);
        missing.push(identifier);
      }
      continue;
    }
    Object.assign(prompt, filterFields(session.edited));
    mirrorFieldsToActivePreset(name, identifier, session.edited);
  }
  return missing;
}

async function lockDefaultSnapshot(preset, name, idx) {
  const meta = readMeta(preset);
  if (meta.defaultSnapshotLocked) return;
  meta.defaultSnapshot = buildDefaultSnapshotLock(preset);
  meta.defaultSnapshotLocked = true;
  meta.defaultExtra = captureExtra(preset) ?? void 0;
  await saveMeta(name, idx, meta);
}
function mergeBaseSnapshot(profile, snapshot, name, sessionEdits) {
  const previousPrompts = profile.prompts;
  profile.prompts = snapshot.map((s) => {
    const entry = {
      identifier: s.identifier,
      enabled: s.enabled
    };
    const session = sessionEdits.get(bufferKey(name, s.identifier));
    if (session && s.fields && !promptFieldsEqual(s.fields, session.initial)) {
      entry.fields = s.fields;
    } else if (!session) {
      const prior = previousPrompts.find((p) => p.identifier === s.identifier)?.fields;
      if (prior) entry.fields = prior;
    }
    return entry;
  });
}
function recordDefaultOriginalFields(meta, name, sessionEdits) {
  if (!Array.isArray(meta.defaultSnapshot)) return;
  const prefix = bufferPrefix(name);
  for (const [key, session] of sessionEdits) {
    if (!key.startsWith(prefix)) continue;
    const identifier = key.slice(prefix.length);
    const entry = meta.defaultSnapshot.find((d) => d.identifier === identifier);
    if (!entry || entry.originalFields) continue;
    entry.originalFields = { ...filterFields(session.initial) };
  }
}
function applyDefaultOriginalFields(preset, meta) {
  if (!Array.isArray(meta.defaultSnapshot)) return;
  for (const d of meta.defaultSnapshot) {
    if (!d.originalFields) continue;
    const prompt = findPromptInPreset(preset, d.identifier);
    if (prompt) Object.assign(prompt, filterFields(d.originalFields));
  }
}
function applyDefaultExtra(preset, meta) {
  if (!meta.defaultExtra) return;
  const ext = preset.extensions;
  Object.assign(preset, meta.defaultExtra);
  preset.extensions = ext;
}
function defaultEnabledEntries(preset, meta) {
  if (!Array.isArray(meta.defaultSnapshot)) return [];
  const orderList = findOrderList(preset, resolvePromptOrderTarget());
  const mounted = new Set(Array.isArray(orderList?.order) ? orderList.order.filter((entry) => entry && typeof entry.identifier === "string").map((entry) => entry.identifier) : []);
  return meta.defaultSnapshot.flatMap((entry) => typeof entry.enabled === "boolean" && mounted.has(entry.identifier) ? [{ identifier: entry.identifier, enabled: entry.enabled }] : []);
}

function applyBufferedAndSnapshot(preset, name, sessionEdits, pendingToggles, pendingClears) {
  const missing = applyBufferedEdits(preset, name, sessionEdits, pendingToggles);
  if (missing.length > 0) {
    toastr.warning(`${L("Missing prompts skipped")}: ${missing.join(", ")}`);
  }
  const include = editedIdentifiersForName(name, sessionEdits);
  const prefix = bufferPrefix(name);
  for (const key of pendingClears.keys()) {
    if (key.startsWith(prefix)) include.add(key.slice(prefix.length));
  }
  const snapshot = buildPromptSnapshot(preset, { includeFields: include });
  for (const entry of snapshot) {
    const key = bufferKey(name, entry.identifier);
    if (pendingClears.has(key) && !sessionEdits.has(key)) {
      entry.fields = {};
    }
  }
  return snapshot;
}
function applyPendingClearsToProfile(profile, pendingClears, name) {
  const prefix = bufferPrefix(name);
  const ids = /* @__PURE__ */ new Set();
  for (const key of pendingClears.keys()) {
    if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
  }
  if (ids.size === 0) return;
  if (isPromptBaseProfile(profile)) {
    for (const p of profile.prompts) {
      if (ids.has(p.identifier)) delete p.fields;
    }
  } else {
    for (const c of profile.changes) {
      if (ids.has(c.identifier)) delete c.fields;
    }
  }
}
async function commitBufferedEditsToProfile(profile, snapshot, meta, name, idx, sessionEdits, missingParent) {
  if (isPromptBaseProfile(profile)) {
    mergeBaseSnapshot(profile, snapshot, name, sessionEdits);
    recordDefaultOriginalFields(meta, name, sessionEdits);
  } else {
    const parentEntries = resolveParentStates(profile, meta.profiles);
    if (parentEntries.length > 0) {
      profile.changes = snapshotToChanges(snapshot, parentEntries, profile.changes);
    } else {
      profile.changes = snapshot.map((s) => {
        const change = { identifier: s.identifier, enabled: s.enabled };
        if (s.fields && Object.keys(s.fields).length > 0) change.fields = s.fields;
        return change;
      });
    }
    recordDefaultOriginalFields(meta, name, sessionEdits);
  }
  await saveMeta(name, idx, meta);
  toastr.success(L("Configuration updated"));
  return true;
}
function fmtValue(v) {
  return v === void 0 || v === null ? "" : String(v);
}
function cssEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function buildBreadcrumb(profile, meta) {
  const chain = [];
  const visited = /* @__PURE__ */ new Set();
  let current = { name: profile.name, id: String(profile.id) };
  while (!visited.has(current.id)) {
    visited.add(current.id);
    chain.unshift(current);
    if (chain.length > 50) break;
    const node = getProfile(meta, current.id);
    if (!node || !isPromptDeltaProfile(node)) break;
    const parent2 = getProfile(meta, node.baseId);
    if (!parent2 || !isPromptBaseProfile(parent2) && !isPromptDeltaProfile(parent2)) break;
    current = { name: parent2.name, id: String(parent2.id) };
  }
  const ancestors = chain.slice(0, -1);
  const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1] : void 0;
  const child = (Array.isArray(meta.profiles) ? meta.profiles : []).find(
    (candidate) => isPromptDeltaProfile(candidate) && String(candidate.baseId) === String(profile.id)
  );
  const childName = child ? child.name : void 0;
  const title = [
    ...ancestors.map((item) => item.name),
    profile.name,
    ...childName ? [childName] : []
  ].join(" ▸ ");
  const items = [];
  if (parent) items.push({ name: parent.name, isCurrent: false });
  items.push({ name: profile.name, isCurrent: true });
  if (childName) items.push({ name: childName, isCurrent: false });
  return { items, title };
}
async function openProfileEditorPopup(deps, name, idx, profileId) {
  const { sessionEdits, pendingToggles } = deps;
  const prefix = bufferPrefix(name);
  let dialog = $('<div id="preset_profile_editor" class="pc-manager-container"></div>');
  let searchQuery = "";
  let searchIndex = /* @__PURE__ */ new Map();
  let editTargetId = null;
  let mobileShowRight = false;
  let listLocked = false;
  const reorderedIds = /* @__PURE__ */ new Set();
  const pendingClears = /* @__PURE__ */ new Map();
  const initialOrderIndex = buildProfileOrderCtx(openai_settings[idx], oai_settings.preset_settings_openai === name).orderIndex;
  let popup;
  const currentCtx = () => {
    const preset = openai_settings[idx];
    const meta = readMeta(preset);
    const profile = getProfile(meta, profileId);
    if (!profile || !isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile)) return void 0;
    const isActive = oai_settings.preset_settings_openai === name;
    const orderCtx = buildProfileOrderCtx(preset, isActive);
    return { preset, meta, profile, entries: buildProfileEntries(profile, meta, preset, orderCtx), orderCtx };
  };
  function rebuildSearchIndex() {
    const ctx = currentCtx();
    searchIndex = new Map((ctx?.entries ?? []).map((e) => [
      e.identifier,
      { name: (e.name ?? "").toLowerCase(), content: (e.content ?? "").toLowerCase() }
    ]));
  }
  const FIELD_LABELS = {
    content: L("Content"),
    name: L("Name"),
    role: L("Role"),
    injection_position: L("Position"),
    injection_depth: L("Injection Depth")
  };
  function stagedItems(ctx) {
    const resolvedCtx = ctx ?? currentCtx();
    if (!resolvedCtx) return [];
    const nameById = new Map(resolvedCtx.entries.map((e) => [e.identifier, e.name]));
    const enabledById = new Map(resolvedCtx.entries.map((e) => [e.identifier, e.enabled]));
    const keys = /* @__PURE__ */ new Set();
    for (const k of pendingToggles.keys()) if (k.startsWith(prefix)) keys.add(k);
    for (const k of sessionEdits.keys()) if (k.startsWith(prefix)) keys.add(k);
    for (const k of pendingClears.keys()) if (k.startsWith(prefix)) keys.add(k);
    const items = [];
    for (const key of keys) {
      const identifier = key.slice(prefix.length);
      const item = { identifier, key, label: nameById.get(identifier) ?? identifier, fields: [] };
      const toggleTarget = pendingToggles.get(key);
      if (toggleTarget !== void 0) {
        item.toggle = { original: enabledById.get(identifier) ?? true, target: toggleTarget };
      }
      const session = sessionEdits.get(key);
      if (session) {
        for (const field of PROMPT_FIELD_WHITELIST) {
          if (session.initial[field] !== session.edited[field]) {
            item.fields.push({
              label: FIELD_LABELS[field] ?? field,
              from: fmtValue(session.initial[field]),
              to: fmtValue(session.edited[field])
            });
          }
        }
      }
      if (pendingClears.has(key) && !session) {
        item.clear = true;
      }
      items.push(item);
    }
    const orderIdx = new Map(resolvedCtx.entries.map((e, i) => [e.identifier, i]));
    items.sort((a, b) => {
      const ia = orderIdx.get(a.identifier);
      const ib = orderIdx.get(b.identifier);
      return (ia ?? Number.MAX_SAFE_INTEGER) - (ib ?? Number.MAX_SAFE_INTEGER);
    });
    return items;
  }
  async function renderDialog() {
    const ctx = currentCtx();
    if (!ctx) return;
    const items = stagedItems(ctx);
    const { items: breadcrumb, title: breadcrumbTitle } = buildBreadcrumb(ctx.profile, ctx.meta);
    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, "profile-editor", {
      presetName: name,
      breadcrumb,
      breadcrumbTitle,
      entries: ctx.entries,
      stagedCount: items.length,
      canCommit: items.length > 0,
      listLocked,
      i18n: {
        rename: L("Rename"),
        lockList: listLocked ? L("Unlock list") : L("Lock list"),
        viewStaged: L("View Staged"),
        reset: L("Reset to parent"),
        commit: L("Commit"),
        close: L("Close"),
        back: L("Back"),
        searchPrompts: L("Search prompts..."),
        dragHandle: L("Drag to reorder"),
        clearValueChange: L("Clear value changes"),
        toggleEntry: L("Toggle entry"),
        noEntries: L("No entries"),
        noSearchResults: L("No prompts found")
      }
    });
    const newDialog = $(html);
    const children = newDialog.children().toArray();
    const listEl = dialog.find(".pc-prompt-list");
    const prevScrollTop = listEl.length ? listEl.scrollTop() ?? 0 : 0;
    dialog.empty().append(children);
    rebuildSearchIndex();
    applyBufferOverlay();
    applySearch();
    dialog.find("#pc-search-input").val(searchQuery);
    applyLockVisual();
    const newListEl = dialog.find(".pc-prompt-list");
    if (newListEl.length) {
      const maxScroll = Math.max(0, (newListEl[0].scrollHeight ?? 0) - (newListEl[0].clientHeight ?? 0));
      newListEl.scrollTop(Math.min(prevScrollTop, maxScroll));
    }
    renderRightPane(ctx);
    setupSortable();
    refreshCounts(ctx);
  }
  function applyLockVisual() {
    const btn = dialog.find("#pc-btn-lock");
    btn.toggleClass("active", listLocked);
    btn.attr("title", listLocked ? L("Unlock list") : L("Lock list"));
    btn.find(".pc-btn-label").text(listLocked ? L("Unlock list") : L("Lock list"));
    btn.find("i").attr("class", listLocked ? "fa-solid fa-unlock" : "fa-solid fa-lock");
    dialog.find(".pc-prompt-list").toggleClass("pc-locked", listLocked);
  }
  function applyBufferOverlay() {
    dialog.find(".pc-prompt-card").each(function() {
      const entry = $(this);
      const identifier = String(entry.data("identifier"));
      const key = bufferKey(name, identifier);
      const toggleTarget = pendingToggles.get(key);
      const session = sessionEdits.get(key);
      const toggle = entry.find(".pc-btn-toggle");
      if (toggle.length && toggleTarget !== void 0) {
        toggle.toggleClass("on", toggleTarget).toggleClass("off", !toggleTarget);
        toggle.html(toggleTarget ? '<i class="fa-solid fa-toggle-on"></i> On' : '<i class="fa-solid fa-toggle-off"></i> Off');
        entry.toggleClass("disabled", !toggleTarget);
      }
      if (session?.edited.name !== void 0) {
        entry.find(".pc-card-name").text(session.edited.name).attr("title", identifier);
        const idx2 = searchIndex.get(identifier);
        if (idx2) idx2.name = session.edited.name.toLowerCase();
      }
      if (sessionEdits.has(key) || pendingToggles.has(key) || pendingClears.has(key) || reorderedIds.has(identifier)) {
        entry.addClass("dirty");
      }
    });
  }
  function applySearch() {
    const q = searchQuery.toLowerCase().trim();
    let visible = 0;
    dialog.find(".pc-prompt-card").each(function() {
      const identifier = String($(this).data("identifier"));
      const idx2 = searchIndex.get(identifier);
      const match = !q || !!(idx2 && (idx2.name.includes(q) || idx2.content.includes(q) || identifier.toLowerCase().includes(q)));
      $(this).toggle(match);
      if (match) visible++;
    });
    dialog.find("#pc-prompt-empty-search").toggle(visible === 0 && q.length > 0);
  }
  function renderStagedPane(ctx) {
    const diffArea = dialog.find("#pc-diff-area");
    diffArea.empty();
    const items = stagedItems(ctx);
    if (items.length === 0) {
      diffArea.append($('<div class="pc-diff-empty"></div>').text(L("No staged changes")));
      return;
    }
    diffArea.append($('<h3 class="pc-diff-title"></h3>').text(L("Staged Changes")));
    const list = $('<ul class="pc-diff-list"></ul>');
    for (const item of items) {
      if (item.toggle) {
        list.append($('<li class="pc-diff-item diff-toggle"></li>').append($('<span class="pc-diff-desc"></span>').text(`${L("Switch")}: ${item.toggle.original ? L("On") : L("Off")} → ${item.toggle.target ? L("On") : L("Off")}`)).append(buildUndoBtn(item.key, item.identifier)));
      }
      for (const f of item.fields) {
        list.append($('<li class="pc-diff-item diff-modify"></li>').append($('<span class="pc-diff-desc"></span>').text(`${item.label}: ${f.from || "∅"} → ${f.to || "∅"}`)).append(buildUndoBtn(item.key, item.identifier)));
      }
      if (item.clear) {
        list.append($('<li class="pc-diff-item diff-clear"></li>').append($('<span class="pc-diff-desc"></span>').text(`${item.label}: ${L("Clear value changes")}`)).append(buildUndoBtn(item.key, item.identifier, true)));
      }
    }
    diffArea.append(list);
  }
  function buildUndoBtn(key, identifier, onlyClear = false) {
    const undo = $('<button class="pc-btn-undo"></button>').append($('<i class="fa-solid fa-rotate-left"></i>')).append(" " + L("Undo"));
    undo.on("click", () => {
      if (listLocked) return;
      if (onlyClear) {
        pendingClears.delete(key);
      } else {
        undoStaged(key, identifier);
      }
      refreshEntryRow(identifier);
      refreshCounts();
      renderRightPane();
    });
    return undo;
  }
  function renderRightPane(ctx) {
    dialog.find(".pc-layout").toggleClass("pc-show-right", mobileShowRight);
    dialog.find(".pc-layout").toggleClass("pc-editing", !!editTargetId);
    const diffArea = dialog.find("#pc-diff-area");
    const editArea = dialog.find("#pc-edit-area");
    if (editTargetId) {
      const resolvedCtx = ctx ?? currentCtx();
      const view = resolvedCtx?.entries.find((e) => e.identifier === editTargetId);
      if (resolvedCtx && view?.editable) {
        editArea.empty().append(buildInlineEdit(resolvedCtx.preset, editTargetId));
        editArea.show();
        diffArea.hide();
        return;
      }
      editTargetId = null;
      mobileShowRight = false;
    }
    editArea.hide();
    diffArea.show();
    renderStagedPane(ctx);
  }
  function buildInlineEdit(preset, identifier) {
    const prompt = findPromptInPreset(preset, identifier);
    const wrap = $('<div class="pc-edit-form"></div>');
    if (!prompt) {
      wrap.append($('<div class="pc-diff-empty"></div>').text(L("No entries")));
      return wrap;
    }
    const header = $('<div class="pc-editor-header"></div>');
    header.append($("<h3></h3>").text(prompt.name ?? identifier));
    const actions = $('<div class="pc-editor-actions"></div>');
    const prevSession = sessionEdits.get(bufferKey(name, identifier));
    const current = prevSession ? { ...capturePromptFields(prompt), ...prevSession.edited } : void 0;
    const form = buildPromptEditForm(preset, identifier, current);
    const saveBtn = $('<button class="pc-btn-icon pc-btn-icon-primary" title="' + L("Save") + '"></button>').append($('<i class="fa-solid fa-save"></i>')).append(" " + L("Save"));
    const cancelBtn = $('<button class="pc-btn-icon" title="' + L("Cancel") + '"></button>').append($('<i class="fa-solid fa-times"></i>')).append(" " + L("Cancel"));
    saveBtn.on("click", () => {
      if (listLocked) return;
      const editedFields = form.collectFields();
      if (editedFields) {
        const key = bufferKey(name, identifier);
        pendingClears.delete(key);
        const session = sessionEdits.get(key);
        const initial = session?.initial ?? capturePromptFields(prompt);
        const edited = { ...session?.edited ?? {}, ...filterFields(editedFields) };
        if (promptFieldsEqual(edited, initial)) {
          sessionEdits.delete(key);
        } else {
          sessionEdits.set(key, { initial, edited });
        }
      }
      editTargetId = null;
      mobileShowRight = false;
      refreshEntryRow(identifier);
      refreshCounts();
      renderRightPane();
    });
    cancelBtn.on("click", () => {
      editTargetId = null;
      mobileShowRight = false;
      renderRightPane();
    });
    actions.append(saveBtn).append(cancelBtn);
    header.append(actions);
    wrap.append(header);
    wrap.append(form.container);
    return wrap;
  }
  function refreshEntryRow(identifier, ctx) {
    const row = dialog.find(`.pc-prompt-card[data-identifier="${cssEscape(identifier)}"]`);
    if (row.length === 0) return;
    const resolvedCtx = ctx ?? currentCtx();
    const view = resolvedCtx?.entries.find((e) => e.identifier === identifier);
    const key = bufferKey(name, identifier);
    const toggleTarget = pendingToggles.get(key);
    const session = sessionEdits.get(key);
    const enabled = toggleTarget ?? view?.enabled ?? true;
    const displayName = session?.edited.name ?? view?.name ?? identifier;
    row.find(".pc-card-name").text(displayName).attr("title", identifier);
    const idx2 = searchIndex.get(identifier);
    if (idx2) idx2.name = displayName.toLowerCase();
    const toggle = row.find(".pc-btn-toggle");
    if (toggle.length) {
      toggle.toggleClass("on", enabled).toggleClass("off", !enabled);
      toggle.html(enabled ? '<i class="fa-solid fa-toggle-on"></i> On' : '<i class="fa-solid fa-toggle-off"></i> Off');
    }
    const clearBtn = row.find(".pc-card-clear");
    const shouldHaveClear = !!view?.clearable;
    if (shouldHaveClear && clearBtn.length === 0) {
      const btn = $('<button class="pc-card-clear" title="' + L("Clear value changes") + '"><i class="fa-solid fa-eraser"></i></button>');
      const toggleEl = row.find(".pc-btn-toggle");
      if (toggleEl.length) btn.insertBefore(toggleEl);
      else row.append(btn);
    } else if (!shouldHaveClear) {
      clearBtn.remove();
    }
    row.toggleClass("disabled", !enabled);
    row.toggleClass("dirty", sessionEdits.has(key) || pendingToggles.has(key) || pendingClears.has(key) || reorderedIds.has(identifier));
    row.toggleClass("persistent", !!view?.hasPersistentDiff);
  }
  function undoStaged(key, identifier) {
    pendingToggles.delete(key);
    const session = sessionEdits.get(key);
    if (session) {
      sessionEdits.delete(key);
      const preset = openai_settings[idx];
      const prompt = findPromptInPreset(preset, identifier);
      if (prompt) {
        for (const f of PROMPT_FIELD_WHITELIST) {
          if (!(f in session.initial)) delete prompt[f];
        }
        Object.assign(prompt, session.initial);
      }
      if (oai_settings.preset_settings_openai === name) {
        const livePrompts = Array.isArray(oai_settings.prompts) ? oai_settings.prompts : [];
        const livePrompt = livePrompts.find((p) => p && p.identifier === identifier);
        if (livePrompt) {
          for (const f of PROMPT_FIELD_WHITELIST) {
            if (!(f in session.initial)) delete livePrompt[f];
          }
          Object.assign(livePrompt, filterFields(session.initial));
        }
      }
    }
    refreshEntryRow(identifier);
    refreshCounts();
    renderRightPane();
  }
  function setupSortable() {
    const listEl = dialog.find(".pc-prompt-list");
    if (!listEl.length) return;
    const isActive = oai_settings.preset_settings_openai === name;
    const shouldSortable = isActive && !searchQuery && !listLocked;
    const isSortable = !!listEl.data("ui-sortable");
    if (isSortable && !shouldSortable) listEl.sortable("destroy");
    if (shouldSortable && !isSortable) {
      listEl.sortable({
        axis: "y",
        handle: ".pc-drag-handle",
        items: ".pc-prompt-card",
        placeholder: "pc-sortable-placeholder",
        start: () => listEl.addClass("sorting"),
        stop: () => listEl.removeClass("sorting"),
        update: () => {
          void onReorder(listEl);
        }
      });
    }
  }
  async function onReorder(listEl) {
    if (listLocked) return;
    const preset = openai_settings[idx];
    const orderList = findOrderList(preset, resolvePromptOrderTarget());
    if (!orderList || !Array.isArray(orderList.order)) return;
    const domIds = listEl.find(".pc-prompt-card").map(function() {
      return String($(this).data("identifier"));
    }).get();
    const order = orderList.order;
    const inDom = new Set(domIds);
    const byId = new Map(order.map((o) => [o.identifier, o]));
    const newOrder = [
      ...domIds.map((id) => byId.get(id)).filter((o) => !!o),
      ...order.filter((o) => !inDom.has(o.identifier))
    ];
    if (newOrder.length === order.length && newOrder.every((o, i) => o.identifier === order[i].identifier)) return;
    const newIndex = new Map(newOrder.map((o, i) => [o.identifier, i]));
    for (const o of newOrder) {
      const dirtyNow = initialOrderIndex.get(o.identifier) !== newIndex.get(o.identifier);
      const wasDirty = reorderedIds.has(o.identifier);
      if (dirtyNow !== wasDirty) {
        if (dirtyNow) reorderedIds.add(o.identifier);
        else reorderedIds.delete(o.identifier);
        refreshEntryRow(o.identifier);
      }
    }
    orderList.order = newOrder;
    await saveMeta(name, idx, readMeta(preset));
    deps.refreshActivePresetUI(name);
  }
  function refreshCounts(ctx) {
    const n = stagedItems(ctx).length;
    dialog.find(".pc-btn-view-staged .pc-staged-count").text(`(${n})`);
    const commitBtn = dialog.find("#pc-btn-commit");
    commitBtn.prop("disabled", n === 0);
    commitBtn.toggleClass("disabled", n === 0);
  }
  const clearBuffers = () => {
    clearBufferedForName(name, sessionEdits, pendingToggles);
    pendingClears.clear();
  };
  dialog.on("click", ".pc-prompt-card", function(e) {
    if (listLocked) return;
    if ($(e.target).closest(".pc-drag-handle, .pc-card-clear, .pc-btn-toggle, button").length) return;
    const identifier = String($(this).data("identifier"));
    const ctx = currentCtx();
    const view = ctx?.entries.find((x) => x.identifier === identifier);
    if (!view?.editable) return;
    editTargetId = identifier;
    mobileShowRight = true;
    renderRightPane();
  });
  dialog.on("click", ".pc-btn-toggle", function(e) {
    e.stopPropagation();
    const toggle = $(this);
    const entry = toggle.closest(".pc-prompt-card");
    const identifier = String(entry.data("identifier"));
    const key = bufferKey(name, identifier);
    const on = toggle.hasClass("on");
    const target = !on;
    const ctx = currentCtx();
    let resolvedEnabled;
    if (ctx) {
      const resolved = resolveProfilePrompts(ctx.profile, ctx.meta.profiles, /* @__PURE__ */ new Set());
      resolvedEnabled = resolved.find((x) => x.identifier === identifier)?.enabled;
    }
    if (resolvedEnabled === target) {
      pendingToggles.delete(key);
    } else {
      pendingToggles.set(key, target);
    }
    refreshEntryRow(identifier, ctx);
    refreshCounts(ctx);
    renderRightPane(ctx);
  });
  dialog.on("click", ".pc-card-clear", function(e) {
    e.stopPropagation();
    if (listLocked) return;
    const entry = $(this).closest(".pc-prompt-card");
    const identifier = String(entry.data("identifier"));
    const key = bufferKey(name, identifier);
    const ctx = currentCtx();
    if (!ctx) return;
    const preset = openai_settings[idx];
    const session = sessionEdits.get(key);
    if (session) {
      sessionEdits.delete(key);
      const prompt = findPromptInPreset(preset, identifier);
      if (prompt) {
        for (const f of PROMPT_FIELD_WHITELIST) {
          if (!(f in session.initial)) delete prompt[f];
        }
        Object.assign(prompt, session.initial);
      }
      if (oai_settings.preset_settings_openai === name) {
        const livePrompts = Array.isArray(oai_settings.prompts) ? oai_settings.prompts : [];
        const livePrompt = livePrompts.find((p) => p && p.identifier === identifier);
        if (livePrompt) {
          for (const f of PROMPT_FIELD_WHITELIST) {
            if (!(f in session.initial)) delete livePrompt[f];
          }
          Object.assign(livePrompt, filterFields(session.initial));
        }
      }
    }
    pendingClears.set(key, true);
    renderRightPane(ctx);
    refreshEntryRow(identifier, ctx);
    refreshCounts(ctx);
  });
  dialog.on("click", ".pc-btn-view-staged", function() {
    editTargetId = null;
    mobileShowRight = true;
    renderRightPane();
  });
  dialog.on("click", "#pc-btn-back", function() {
    editTargetId = null;
    mobileShowRight = false;
    renderRightPane();
  });
  dialog.on("click", "#pc-btn-rename", function() {
    const ctx = currentCtx();
    if (!ctx) return;
    const currentItem = dialog.find(".pc-breadcrumb-item.pc-breadcrumb-current");
    if (currentItem.length === 0) return;
    const currentName = ctx.profile.name;
    const input = $("<input>", {
      type: "text",
      class: "pc-header-rename-input",
      value: currentName
    });
    currentItem.replaceWith(input);
    input.focus();
    let done = false;
    input.on("blur keydown", async function(evt) {
      const key = evt.originalEvent?.key ?? "";
      if (evt.type === "keydown" && key !== "Enter" && key !== "Escape") return;
      evt.stopPropagation();
      if (done) return;
      done = true;
      const newName = key === "Escape" ? currentName : input.val().trim() || currentName;
      if (newName !== currentName && key !== "Escape") {
        ctx.profile.name = newName;
        await saveMeta(name, idx, ctx.meta);
        toastr.success(`${L("Rename")}: ${newName}`);
        await renderDialog();
        await deps.onGridRefresh();
      } else {
        await renderDialog();
      }
    });
  });
  dialog.on("click", "#pc-btn-reset", async function() {
    const ctx = currentCtx();
    if (!ctx) return;
    if (!isPromptBaseProfile(ctx.profile) && !isPromptDeltaProfile(ctx.profile)) {
      toastr.warning(L("This profile type cannot be reset"));
      return;
    }
    const confirm = await callGenericPopup(L("Reset this configuration to its parent?"), POPUP_TYPE.CONFIRM);
    if (!confirm) return;
    const preset = openai_settings[idx];
    const meta = readMeta(preset);
    const profile = getProfile(meta, profileId);
    if (!profile) return;
    if (isPromptDeltaProfile(profile)) {
      const parentStates = resolveParentStates(profile, meta.profiles);
      if (parentStates.length > 0) {
        applyBaseProfile(preset, {
          id: profile.baseId || "parent",
          prompts: parentStates
        });
        profile.changes = [];
        delete profile.sampling;
        applyDefaultExtra(preset, meta);
      } else {
        if (!meta.defaultSnapshot || meta.defaultSnapshot.length === 0) {
          toastr.warning(L("No default baseline available"));
          return;
        }
        applyDefaultOriginalFields(preset, meta);
        applyDefaultExtra(preset, meta);
        const defaultPrompts = defaultEnabledEntries(preset, meta);
        applyBaseProfile(preset, {
          id: profile.baseId || "default",
          prompts: defaultPrompts
        });
        profile.changes = [];
        delete profile.sampling;
      }
      await saveMeta(name, idx, meta);
      toastr.success(L("Configuration reset"));
      deps.refreshActivePresetUI(name);
    } else if (isPromptBaseProfile(profile)) {
      if (!meta.defaultSnapshot || meta.defaultSnapshot.length === 0) {
        toastr.warning(L("No default baseline available"));
        return;
      }
      applyDefaultOriginalFields(preset, meta);
      applyDefaultExtra(preset, meta);
      const defaultPrompts = defaultEnabledEntries(preset, meta);
      profile.prompts = structuredClone(defaultPrompts);
      delete profile.sampling;
      applyBaseProfile(preset, {
        id: profile.id,
        name: profile.name,
        prompts: defaultPrompts
      });
      await saveMeta(name, idx, meta);
      toastr.success(L("Configuration reset"));
      deps.refreshActivePresetUI(name);
    }
    clearBuffers();
    reorderedIds.clear();
    editTargetId = null;
    mobileShowRight = false;
    await renderDialog();
    await deps.onGridRefresh();
  });
  dialog.on("click", "#pc-btn-commit", async function() {
    const ctx = currentCtx();
    if (!ctx) return;
    if (stagedItems().length === 0) return;
    if (!isPromptBaseProfile(ctx.profile) && !isPromptDeltaProfile(ctx.profile)) {
      toastr.warning(L("This profile type cannot be edited with switches"));
      return;
    }
    const choice = await chooseProfileSaveTarget();
    if (!choice) return;
    let deltaName = null;
    if (choice === "create") {
      deltaName = await Popup.show.input(L("Derived profile name:"), "");
      if (!deltaName) return;
    }
    const preset = openai_settings[idx];
    const snapshot = applyBufferedAndSnapshot(preset, name, sessionEdits, pendingToggles, pendingClears);
    if (choice === "update") {
      applyPendingClearsToProfile(ctx.profile, pendingClears, name);
      const ok = await commitBufferedEditsToProfile(ctx.profile, snapshot, ctx.meta, name, idx, sessionEdits);
      if (!ok) return;
    } else {
      const profiles = Array.isArray(ctx.meta.profiles) ? ctx.meta.profiles : [];
      const parentEntries = resolveProfilePrompts(ctx.profile, ctx.meta.profiles, /* @__PURE__ */ new Set());
      const changes = snapshotToChanges(snapshot, parentEntries, []);
      profiles.push(buildDerivedProfile(ctx.profile, deltaName, changes, captureSampling(preset) ?? void 0));
      ctx.meta.profiles = profiles;
      recordDefaultOriginalFields(ctx.meta, name, sessionEdits);
      await saveMeta(name, idx, ctx.meta);
      toastr.success(L("Derived profile created"));
    }
    deps.refreshActivePresetUI(name);
    clearBuffers();
    reorderedIds.clear();
    editTargetId = null;
    mobileShowRight = false;
    await renderDialog();
    await deps.onGridRefresh();
  });
  dialog.on("click", "#pc-btn-close", async function() {
    if (stagedItems().length > 0) {
      const discard = await callGenericPopup(L("You have uncommitted changes. Discard them?"), POPUP_TYPE.CONFIRM);
      if (!discard) return;
      toastr.info(L("Uncommitted changes discarded"));
      clearBuffers();
    }
    popup.completeCancelled();
  });
  dialog.on("click", "#pc-btn-lock", function() {
    listLocked = !listLocked;
    applyLockVisual();
    if (listLocked) {
      editTargetId = null;
      mobileShowRight = false;
      renderRightPane();
    }
    setupSortable();
  });
  dialog.on("input", "#pc-search-input", function() {
    searchQuery = String($(this).val() ?? "");
    applySearch();
    setupSortable();
  });
  await renderDialog();
  popup = new Popup(dialog, POPUP_TYPE.TEXT, "", {
    okButton: false,
    cancelButton: false,
    transparent: true,
    wide: true,
    large: true,
    allowVerticalScrolling: true
  });
  await popup.show();
  if (stagedItems().length > 0) {
    const discard = await callGenericPopup(L("You have uncommitted changes. Discard them?"), POPUP_TYPE.CONFIRM);
    if (discard) {
      toastr.info(L("Uncommitted changes discarded"));
    }
    clearBuffers();
  }
}

async function openPresetCards() {
  let presets = buildPresetList();
  let isBatchMode = false;
  const batchSelectedCards = /* @__PURE__ */ new Set();
  let isConciseMode = localStorage.getItem("preset_cards_concise") === "true";
  const sessionEdits = /* @__PURE__ */ new Map();
  const pendingToggles = /* @__PURE__ */ new Map();
  const html = await renderExtensionTemplateAsync(EXTENSION_NAME, "cards", getCardsTemplateContext());
  const dialog = $(html);
  if (isConciseMode) {
    dialog.addClass("preset_cards_concise_mode");
    dialog.find("#preset_cards_concise_btn").addClass("active");
  }
  function updateCount(visible, total) {
    const el = dialog.find("#preset_cards_count");
    el.text(visible === total ? `${total} ${L("presets")}` : `${visible} / ${total}`);
  }
  function refreshActivePresetUI(presetName) {
    if (oai_settings.preset_settings_openai === presetName) {
      const idx = openai_setting_names[presetName];
      if (idx !== void 0) void fastApplyPreset(idx, presetName);
    }
  }
  function activatePreset(name, idx) {
    void fastApplyPreset(idx, name);
    refreshActiveCardSelection();
  }
  async function refreshGrid(opts) {
    const searchEl = dialog.find("#preset_cards_search");
    const query = String(searchEl.val() ?? "");
    const newHtml = await renderExtensionTemplateAsync(EXTENSION_NAME, "cards", getCardsTemplateContext());
    dialog.html($(newHtml).html());
    if (opts?.applyBackgrounds !== false) applyCachedBackgrounds(dialog);
    if (query) dialog.find("#preset_cards_search").val(query);
    if (isConciseMode) dialog.find("#preset_cards_concise_btn").addClass("active");
    dialog.find(".preset_card_profile_row.active").parents(".preset_card_profile_group").addClass("expanded");
    dialog.find("#preset_cards_search").trigger("input");
  }
  function reselectFirstPreset() {
    if (Object.keys(openai_setting_names).length) {
      const newActiveName = Object.keys(openai_setting_names)[0];
      oai_settings.preset_settings_openai = newActiveName;
      void fastApplyPreset(openai_setting_names[newActiveName], newActiveName);
    }
  }
  function refreshActiveCardSelection() {
    dialog.find(".preset_card").removeClass("selected");
    const newActive = oai_settings.preset_settings_openai;
    if (newActive) {
      dialog.find(".preset_card").filter(function() {
        return $(this).attr("data-preset-name") === newActive;
      }).addClass("selected");
    }
  }
  async function deletePresetByName(nameToDelete, opts) {
    const value = openai_setting_names[nameToDelete];
    if (value === void 0) return false;
    $(`#settings_preset_openai option[value="${value}"]`).remove();
    delete openai_setting_names[nameToDelete];
    if (oai_settings.preset_settings_openai === nameToDelete) {
      oai_settings.preset_settings_openai = null;
      if (opts.activeHandling === "immediate") {
        reselectFirstPreset();
      }
    }
    const response = await fetch("/api/presets/delete", {
      method: "POST",
      headers: getRequestHeaders(),
      body: JSON.stringify({ apiId: "openai", name: nameToDelete })
    });
    if (!response.ok) return false;
    const active = getActiveProfile();
    if (active && active.presetName === nameToDelete) {
      setActiveProfile(void 0);
    }
    clearBufferedForName(nameToDelete, sessionEdits, pendingToggles);
    opts.onDeleted?.();
    dialog.find(".preset_card").filter(function() {
      return $(this).attr("data-preset-name") === nameToDelete;
    }).remove();
    presets = presets.filter((p) => p.name !== nameToDelete);
    opts.onBeforeEmit?.();
    try {
      await eventSource.emit(event_types.PRESET_DELETED, { apiId: "openai", name: nameToDelete });
    } catch (err) {
      console.error(opts.emitLog, err);
    }
    return true;
  }
  dialog.on("input", "#preset_cards_search", function() {
    const q = String($(this).val()).toLowerCase().trim();
    let vis = 0;
    dialog.find(".preset_card").each(function() {
      const name = String($(this).data("preset-name")).toLowerCase();
      const desc = $(this).find(".preset_card_desc").text().toLowerCase();
      const match = !q || name.includes(q) || desc.includes(q);
      $(this).toggle(match);
      if (match) vis++;
    });
    const emptyEl = dialog.find("#preset_cards_empty");
    if (vis === 0 && emptyEl.length === 0) {
      dialog.find("#preset_cards_grid").append(
        `<div id="preset_cards_empty">${t`No presets found`}</div>`
      );
    }
    dialog.find("#preset_cards_empty").toggle(vis === 0);
    updateCount(vis, presets.length);
  });
  let pressTimer;
  async function showConciseProfilesModal(card) {
    const name = card.attr("data-preset-name");
    const idx = card.data("preset-index");
    const preset = openai_settings[idx];
    const meta = readMeta(preset);
    if (!meta.profiles || meta.profiles.length === 0) {
      toastr.info(L("No configurations saved for this preset"));
      return;
    }
    const container = $('<div class="preset_card_profiles_section" style="margin-top:0; padding:0; border:none; box-shadow:none; background:transparent;"></div>');
    const list = $('<div class="preset_card_profiles_list"></div>');
    meta.profiles.forEach((p) => {
      const row = $('<div class="preset_card_profile_row" style="cursor:pointer; padding:10px 14px; margin-bottom:4px;"></div>').attr("data-profile-id", String(p.id));
      row.append($('<div class="preset_card_profile_name" style="font-size:14px;"></div>').text(p.name));
      row.on("click", async function() {
        const profileId = row.data("profile-id");
        const profile = getProfile(meta, profileId);
        if (!profile) return;
        applyProfileToPreset(preset, profile, meta.profiles);
        await saveMeta(name, idx, meta);
        toastr.success(L("Configuration loaded"));
        setActiveProfile({ presetName: name, profileId: String(profileId) });
        activatePreset(name, idx);
        clearBufferedForName(name, sessionEdits, pendingToggles);
        $(this).closest(".popup").find(".popup-controls .menu_button").click();
        await refreshGrid();
      });
      list.append(row);
    });
    container.append(list);
    callGenericPopup(container, POPUP_TYPE.TEXT, "", {
      wide: false,
      large: false
    });
  }
  dialog.on("mousedown touchstart", ".preset_card", function(e) {
    if (!isConciseMode || isBatchMode) return;
    if (e.type === "mousedown" && e.which !== 1) return;
    const card = $(this);
    pressTimer = window.setTimeout(function() {
      card.data("long-pressed", true);
      showConciseProfilesModal(card);
    }, 600);
  });
  dialog.on("mousemove touchmove", ".preset_card", function() {
    clearTimeout(pressTimer);
  });
  dialog.on("mouseup touchend mouseleave", ".preset_card", function() {
    clearTimeout(pressTimer);
  });
  dialog.on("contextmenu", ".preset_card", function(e) {
    if (isConciseMode && !isBatchMode && $(this).data("long-pressed")) {
      e.preventDefault();
    }
  });
  dialog.on("click", ".preset_card", function(e) {
    if ($(this).data("long-pressed")) {
      $(this).data("long-pressed", false);
      return;
    }
    if ($(e.target).closest(".preset_card_actions").length) return;
    if ($(e.target).closest(".preset_card_profiles_section").length) return;
    const name = $(this).attr("data-preset-name");
    if (isBatchMode) {
      if (batchSelectedCards.has(name)) {
        batchSelectedCards.delete(name);
        $(this).removeClass("batch_selected");
      } else {
        batchSelectedCards.add(name);
        $(this).addClass("batch_selected");
      }
      return;
    }
    const idx = $(this).data("preset-index");
    dialog.find(".preset_card").removeClass("selected");
    $(this).addClass("selected");
    void fastApplyPreset(idx, name);
    toastr.success(`${t`Switched to`} ${name}`);
  });
  dialog.on("click", "#preset_cards_clear_cache_btn", async function() {
    const confirm = await callGenericPopup(L("Clear all cached background images?"), POPUP_TYPE.CONFIRM);
    if (!confirm) return;
    await clearImageCache();
    toastr.success(L("Cache cleared successfully"));
    await refreshGrid({ applyBackgrounds: true });
  });
  dialog.on("click", ".preset_card_edit_btn", function(e) {
    e.stopPropagation();
    const name = $(this).data("preset-name");
    const idx = $(this).data("preset-index");
    openEditModal(name, idx, async () => {
      refreshActivePresetUI(name);
      const preset = openai_settings[idx];
      const meta = readMeta(preset);
      const card = dialog.find(`.preset_card[data-preset-index="${idx}"]`);
      if (meta.description) {
        let descEl = card.find(".preset_card_desc");
        if (descEl.length === 0) {
          card.find(".preset_card_body").prepend('<div class="preset_card_desc"></div>');
          descEl = card.find(".preset_card_desc");
        }
        descEl.text(meta.description).attr("title", meta.description);
      } else {
        card.find(".preset_card_desc").remove();
      }
      const chipsEl = card.find(".preset_card_tags");
      chipsEl.empty();
      if (meta.models.length > 0) {
        if (chipsEl.length === 0) {
          const profilesEl = card.find(".preset_card_profiles_section");
          if (profilesEl.length > 0) {
            profilesEl.before('<div class="preset_card_tags"></div>');
          } else {
            card.find(".preset_card_body").append('<div class="preset_card_tags"></div>');
          }
        }
        for (const mid of meta.models) {
          const def = AVAILABLE_MODELS.find((m) => m.id === mid);
          const logoHtml = def ? `<img src="${LOGO_BASE + def.logo}" alt="" />` : "";
          const label = def ? def.label : mid;
          card.find(".preset_card_tags").append(
            `<span class="preset_card_chip" title="${label}">${logoHtml}${label}</span>`
          );
        }
      } else {
        chipsEl.remove();
      }
      const bgImage = meta.bgImage || "";
      card.toggleClass("has_bg", !!bgImage);
      let bgEl = card.find(".preset_card_bg_image");
      if (bgImage) {
        if (bgEl.length === 0) {
          card.append('<div class="preset_card_bg_image"></div>');
          bgEl = card.find(".preset_card_bg_image");
        }
        bgEl.css("background-image", "none").attr("data-bg-url", bgImage);
        applyCachedBackgrounds(card);
      } else {
        bgEl.remove();
      }
      const footerEl = card.find(".preset_card_footer");
      if (footerEl.length > 0) {
        footerEl.empty();
        const tags = [];
        if (preset["temperature"] != null) tags.push(`<span class="preset_card_tag" title="Temperature"><span class="tag_label">T</span><span class="tag_value">${preset["temperature"]}</span></span>`);
        if (preset["top_p"] != null) tags.push(`<span class="preset_card_tag" title="Top P"><span class="tag_label">P</span><span class="tag_value">${preset["top_p"]}</span></span>`);
        if (preset["top_k"] != null) tags.push(`<span class="preset_card_tag" title="Top K"><span class="tag_label">K</span><span class="tag_value">${preset["top_k"]}</span></span>`);
        if (preset["openai_max_context"]) tags.push(`<span class="preset_card_tag" title="Context"><span class="tag_label">Ctx</span><span class="tag_value">${preset["openai_max_context"]}</span></span>`);
        if (preset["openai_max_tokens"]) tags.push(`<span class="preset_card_tag" title="Max Tokens (Response)"><span class="tag_label">Tok</span><span class="tag_value">${preset["openai_max_tokens"]}</span></span>`);
        if (preset["stream_openai"]) tags.push('<span class="preset_card_tag" title="Streaming"><span class="tag_value">Stream</span></span>');
        footerEl.append(tags.join(""));
      }
    });
  });
  function exportPresetFile(name, idx) {
    const preset = structuredClone(openai_settings[idx]);
    const sensitiveFields = [
      "reverse_proxy",
      "proxy_password",
      "custom_url",
      "custom_include_body",
      "custom_exclude_body",
      "custom_include_headers",
      "vertexai_region",
      "vertexai_express_project_id",
      "azure_base_url",
      "azure_deployment_name",
      "workers_ai_account_id"
    ];
    sensitiveFields.forEach((field) => delete preset[field]);
    if (settingsToUpdate) {
      for (const [, [, settingName, , isConnection]] of Object.entries(settingsToUpdate)) {
        if (isConnection) {
          delete preset[settingName];
        }
      }
    }
    download(JSON.stringify(preset, null, 4), `${name}.json`, "application/json");
  }
  dialog.on("click", ".preset_card_export_btn", function(e) {
    e.stopPropagation();
    const name = $(this).attr("data-preset-name");
    const idx = $(this).data("preset-index");
    exportPresetFile(name, idx);
  });
  dialog.on("click", ".preset_card_delete_btn", async function(e) {
    e.stopPropagation();
    const nameToDelete = $(this).attr("data-preset-name");
    const confirm = await callGenericPopup(t`Delete the preset? This action is irreversible and your current settings will be overwritten.`, POPUP_TYPE.CONFIRM);
    if (!confirm) return;
    const deleted = await deletePresetByName(nameToDelete, {
      activeHandling: "immediate",
      emitLog: "Error emitting PRESET_DELETED",
      onDeleted: () => toastr.success(t`Preset deleted`),
      onBeforeEmit: () => {
        dialog.find("#preset_cards_search").trigger("input");
        refreshActiveCardSelection();
      }
    });
    if (!deleted) {
      toastr.warning(t`Preset was not deleted from server`);
    }
  });
  dialog.on("click", "#preset_cards_concise_btn", function() {
    isConciseMode = !isConciseMode;
    $(this).toggleClass("active", isConciseMode);
    dialog.toggleClass("preset_cards_concise_mode", isConciseMode);
    localStorage.setItem("preset_cards_concise", String(isConciseMode));
  });
  dialog.on("click", "#preset_cards_multiselect_btn", function() {
    isBatchMode = !isBatchMode;
    $(this).toggleClass("active", isBatchMode);
    dialog.toggleClass("preset_cards_batch_mode", isBatchMode);
    if (isBatchMode) {
      dialog.find("#preset_cards_batch_delete_btn").removeClass("hidden");
    } else {
      dialog.find("#preset_cards_batch_delete_btn").addClass("hidden");
      batchSelectedCards.clear();
      dialog.find(".preset_card").removeClass("batch_selected");
    }
  });
  dialog.on("click", "#preset_cards_batch_delete_btn", async function() {
    if (batchSelectedCards.size === 0) {
      toastr.info(t`No presets selected`);
      return;
    }
    const confirm = await callGenericPopup(t`Delete ${batchSelectedCards.size} presets? This action is irreversible.`, POPUP_TYPE.CONFIRM);
    if (!confirm) return;
    let activeDeleted = false;
    let deletedCount = 0;
    for (const nameToDelete of batchSelectedCards) {
      if (openai_setting_names[nameToDelete] === void 0) continue;
      const wasActive = oai_settings.preset_settings_openai === nameToDelete;
      const deleted = await deletePresetByName(nameToDelete, {
        activeHandling: "deferred",
        emitLog: "Error emitting PRESET_DELETED for batch mode"
      });
      if (deleted) deletedCount++;
      if (wasActive) activeDeleted = true;
    }
    if (activeDeleted) {
      reselectFirstPreset();
      refreshActiveCardSelection();
    }
    if (deletedCount > 0) {
      toastr.success(t`${deletedCount} presets deleted`);
      dialog.find("#preset_cards_search").trigger("input");
    }
    dialog.find("#preset_cards_multiselect_btn").trigger("click");
  });
  dialog.on("click", ".preset_card_add_profile_btn", async function(e) {
    e.stopPropagation();
    const card = $(this).closest(".preset_card");
    const name = card.attr("data-preset-name");
    const idx = card.data("preset-index");
    const profileName = await Popup.show.input(L("Base profile name:"), "");
    if (!profileName) return;
    const preset = openai_settings[idx];
    if (oai_settings.preset_settings_openai === name) {
      const presetBody = getChatCompletionPreset(oai_settings);
      Object.assign(preset, presetBody);
      if (Array.isArray(oai_settings.prompt_order)) {
        preset.prompt_order = structuredClone(oai_settings.prompt_order);
      }
    }
    await lockDefaultSnapshot(preset, name, idx);
    const meta = readMeta(preset);
    const profiles = Array.isArray(meta.profiles) ? meta.profiles : [];
    const missing = applyBufferedEdits(preset, name, sessionEdits, pendingToggles);
    if (missing.length > 0) {
      toastr.warning(`${L("Missing prompts skipped")}: ${missing.join(", ")}`);
    }
    const sampling = captureSampling(preset);
    profiles.push({
      formatVersion: 2,
      kind: "prompt_base",
      id: newProfileId(),
      name: profileName,
      prompts: buildBaseSnapshotDiff(preset, meta.defaultSnapshot),
      ...sampling ? { sampling } : {}
    });
    meta.profiles = profiles;
    await saveMeta(name, idx, meta);
    toastr.success(L("Base profile saved"));
    await refreshGrid();
  });
  dialog.on("click", ".preset_card_export_all_btn", async function(e) {
    e.stopPropagation();
    const card = $(this).closest(".preset_card");
    const name = card.attr("data-preset-name");
    const idx = card.data("preset-index");
    const choice = await chooseFromOptions(L("Export configuration"), [[L("Export all configurations"), "export"]]);
    if (choice !== "export") return;
    const preset = openai_settings[idx];
    const meta = readMeta(preset);
    warnV1ExcludedFromTreeExport(meta);
    download(buildTreeExportData(meta), `${name}-tree.json`, "application/json");
  });
  dialog.on("click", ".preset_card_profile_toggle", function(e) {
    e.stopPropagation();
    $(this).closest(".preset_card_profile_group").toggleClass("expanded");
  });
  dialog.on("click", ".preset_card_profile_name", async function(e) {
    e.stopPropagation();
    const row = $(this).closest(".preset_card_profile_row");
    const profileId = row.data("profile-id");
    const card = $(this).closest(".preset_card");
    const name = card.attr("data-preset-name");
    const idx = card.data("preset-index");
    const preset = openai_settings[idx];
    const meta = readMeta(preset);
    const profile = getProfile(meta, profileId);
    if (!profile) return;
    applyProfileToPreset(preset, profile, meta.profiles, { showMissingToast: true });
    setActiveProfile({ presetName: name, profileId: String(profileId) });
    await saveMeta(name, idx, meta);
    toastr.success(L("Configuration loaded"));
    activatePreset(name, idx);
    clearBufferedForName(name, sessionEdits, pendingToggles);
    await refreshGrid();
  });
  dialog.on("click", ".preset_card_profile_derive", async function(e) {
    e.stopPropagation();
    const row = $(this).closest(".preset_card_profile_row");
    const profileId = row.data("profile-id");
    const card = $(this).closest(".preset_card");
    const name = card.attr("data-preset-name");
    const idx = card.data("preset-index");
    const preset = openai_settings[idx];
    const meta = readMeta(preset);
    const parent = getProfile(meta, profileId);
    if (!parent) return;
    if (!isPromptBaseProfile(parent) && !isPromptDeltaProfile(parent)) {
      toastr.warning(L("Cannot derive from a legacy profile"));
      return;
    }
    const deltaName = await Popup.show.input(L("Derived profile name:"), "");
    if (!deltaName) return;
    const profiles = Array.isArray(meta.profiles) ? meta.profiles : [];
    profiles.push(buildDerivedProfile(parent, deltaName, [], captureSampling(preset) ?? void 0));
    meta.profiles = profiles;
    await saveMeta(name, idx, meta);
    toastr.success(L("Derived profile created"));
    await refreshGrid();
    dialog.find(`.preset_card_profile_row[data-profile-id="${String(parent.id)}"]`).parents(".preset_card_profile_group").addClass("expanded");
  });
  dialog.on("click", ".preset_card_profile_reset", async function(e) {
    e.stopPropagation();
    const row = $(this).closest(".preset_card_profile_row");
    const profileId = row.data("profile-id");
    const card = $(this).closest(".preset_card");
    const name = card.attr("data-preset-name");
    const idx = card.data("preset-index");
    const confirm = await callGenericPopup(L("Reset this configuration to its parent?"), POPUP_TYPE.CONFIRM);
    if (!confirm) return;
    const preset = openai_settings[idx];
    const meta = readMeta(preset);
    const profile = getProfile(meta, profileId);
    if (!profile) return;
    if (isPromptDeltaProfile(profile)) {
      const parentStates = resolveParentStates(profile, meta.profiles);
      if (parentStates.length > 0) {
        applyBaseProfile(preset, {
          id: profile.baseId || "parent",
          prompts: parentStates
        });
        profile.changes = [];
        delete profile.sampling;
        applyDefaultExtra(preset, meta);
      } else {
        if (!meta.defaultSnapshot || meta.defaultSnapshot.length === 0) {
          toastr.warning(L("No default baseline available"));
          return;
        }
        applyDefaultOriginalFields(preset, meta);
        applyDefaultExtra(preset, meta);
        const defaultPrompts = defaultEnabledEntries(preset, meta);
        const tmp = {
          id: profile.baseId || "default",
          prompts: defaultPrompts
        };
        applyBaseProfile(preset, tmp);
        profile.changes = [];
        delete profile.sampling;
      }
      await saveMeta(name, idx, meta);
      toastr.success(L("Configuration reset"));
      refreshActivePresetUI(name);
      clearBufferedForName(name, sessionEdits, pendingToggles);
    } else if (isPromptBaseProfile(profile)) {
      if (!meta.defaultSnapshot || meta.defaultSnapshot.length === 0) {
        toastr.warning(L("No default baseline available"));
        return;
      }
      applyDefaultOriginalFields(preset, meta);
      applyDefaultExtra(preset, meta);
      const defaultPrompts = defaultEnabledEntries(preset, meta);
      profile.prompts = structuredClone(defaultPrompts);
      delete profile.sampling;
      const tmp = {
        id: profile.id,
        name: profile.name,
        prompts: defaultPrompts
      };
      applyBaseProfile(preset, tmp);
      await saveMeta(name, idx, meta);
      toastr.success(L("Configuration reset"));
      refreshActivePresetUI(name);
      clearBufferedForName(name, sessionEdits, pendingToggles);
    } else {
      toastr.warning(L("This profile type cannot be reset"));
      return;
    }
    await refreshGrid();
  });
  dialog.on("click", ".preset_card_profile_delete", async function(e) {
    e.stopPropagation();
    const row = $(this).closest(".preset_card_profile_row");
    const profileId = row.data("profile-id");
    const card = $(this).closest(".preset_card");
    const name = card.attr("data-preset-name");
    const idx = card.data("preset-index");
    const preset = openai_settings[idx];
    const meta = readMeta(preset);
    const profile = getProfile(meta, profileId);
    if (!profile) return;
    const descendantIds = collectDescendantProfileIds(meta, profileId);
    let confirmText = L("Delete this configuration?");
    if (descendantIds.length > 0) {
      const names = descendantIds.map((id) => getProfile(meta, id)?.name || id).join(", ");
      confirmText += `
${L("This will also delete the following derived configurations")}: ${names}`;
    }
    const confirm = await callGenericPopup(confirmText, POPUP_TYPE.CONFIRM);
    if (!confirm) return;
    const deleteIds = /* @__PURE__ */ new Set([String(profileId), ...descendantIds]);
    meta.profiles = (meta.profiles || []).filter((p) => !deleteIds.has(String(p.id)));
    const active = getActiveProfile();
    if (active && active.presetName === name && deleteIds.has(active.profileId)) {
      setActiveProfile(void 0);
    }
    await saveMeta(name, idx, meta);
    await refreshGrid();
  });
  dialog.on("click", ".preset_card_profile_export", async function(e) {
    e.stopPropagation();
    const row = $(this).closest(".preset_card_profile_row");
    const profileId = row.data("profile-id");
    const card = $(this).closest(".preset_card");
    const idx = card.data("preset-index");
    const preset = openai_settings[idx];
    const meta = readMeta(preset);
    const profile = getProfile(meta, profileId);
    if (!profile) return;
    const choice = await chooseProfileExportAction();
    if (choice === "tree") {
      if (isPromptBaseProfile(profile) || isPromptDeltaProfile(profile)) {
        warnV1ExcludedFromTreeExport(meta);
        download(buildTreeExportData(meta, profile.id), `${profile.name}-tree.json`, "application/json");
      } else {
        download(buildProfileExportData(profile, meta), `${profile.name}.json`, "application/json");
      }
    } else if (choice === "profile") {
      download(buildProfileExportData(profile, meta), `${profile.name}.json`, "application/json");
    }
  });
  dialog.on("click", ".preset_card_import_profile_btn", function(e) {
    e.stopPropagation();
    const card = $(this).closest(".preset_card");
    const name = card.attr("data-preset-name");
    const idx = card.data("preset-index");
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("Imported configuration is not a JSON object");
        }
        let defaultName = file.name.replace(/\.json$/i, "");
        const profileName = await Popup.show.input(L("Configuration name:"), defaultName, defaultName);
        if (!profileName) return;
        const preset = openai_settings[idx];
        const meta = readMeta(preset);
        if (!meta.defaultSnapshotLocked) {
          await lockDefaultSnapshot(preset, name, idx);
        }
        const lockedMeta = readMeta(preset);
        const { profiles, warnings } = mergeImportedProfiles(parsed, lockedMeta.profiles, profileName, lockedMeta.defaultSnapshot);
        for (const warning of warnings) {
          toastr.warning(warning);
        }
        lockedMeta.profiles = profiles;
        await saveMeta(name, idx, lockedMeta);
        toastr.success(L("Configuration saved"));
        await refreshGrid({ applyBackgrounds: true });
        dialog.find(`.preset_card[data-preset-name="${name}"]`).find(".preset_card_profile_group").addClass("expanded");
      } catch (err) {
        console.error(err);
        toastr.error(L("Failed to parse configuration file"));
      }
    };
    input.click();
  });
  dialog.on("click", ".preset_card_profile_edit", async function(e) {
    e.stopPropagation();
    const row = $(this).closest(".preset_card_profile_row");
    const profileId = row.data("profile-id");
    const card = $(this).closest(".preset_card");
    const name = card.attr("data-preset-name");
    const idx = card.data("preset-index");
    const preset = openai_settings[idx];
    const meta = readMeta(preset);
    const profile = getProfile(meta, profileId);
    if (!profile) return;
    if (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile)) {
      toastr.warning(L("This profile type cannot be edited with switches"));
      return;
    }
    await openProfileEditorPopup(
      { sessionEdits, pendingToggles, refreshActivePresetUI, onGridRefresh: () => refreshGrid() },
      name,
      idx,
      profileId
    );
  });
  dialog.on("click", "#preset_cards_import_btn", function() {
    $("#openai_preset_import_file").trigger("click");
    dialog.closest(".popup").find(".popup-controls .menu_button").click();
  });
  updateCount(presets.length, presets.length);
  applyCachedBackgrounds(dialog);
  dialog.find(".preset_card_profile_row.active").parents(".preset_card_profile_group").addClass("expanded");
  callGenericPopup(dialog, POPUP_TYPE.TEXT, "", {
    wide: true,
    large: true,
    allowVerticalScrolling: true
  });
}

function refresh() {
  location.reload();
}
function init() {
  initActiveProfile();
  const buttonHtml = `
        <div id="preset_cards_button" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-grip extensionsMenuExtensionButton"></div>` + t`Preset Cards` + "</div>";
  $("#token_counter_wand_container").append(buttonHtml);
  $("#preset_cards_button").on("click", openPresetCards);
  SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: "presetcards",
    callback: async () => {
      await openPresetCards();
      return "";
    },
    helpString: "Opens the preset cards view for Chat Completion presets."
  }));
}

export { init, refresh };
