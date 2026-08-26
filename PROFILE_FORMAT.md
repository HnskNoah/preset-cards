# Profile 文件格式声明

> 适用版本：`formatVersion: 3`（当前唯一受支持的 profile 版本）。本文描述插件持久化的全部数据形状，与 `src/core/domain/types.ts`、`src/meta.ts` 的类型定义一一对应；字段增删须同步更新本文。

## 1. 存放位置

所有扩展数据存于预设对象的 **`extensions['preset_cards']`** 字段，随预设本体经 ST 的 `/api/presets/save` 持久化为预设文件。该字段有两种互斥形态：

| 形态 | 载荷 | 出现位置 |
|---|---|---|
| **元数据容器** | `PresetMeta`（§2） | 用户日常使用的普通预设 |
| **身份标记** | `PresetCardsMarker` | 由「注册链路」投影生成的原生预设 |

标记形态结构（`marker.ts`）：

```jsonc
{
    "marker": "preset-cards-v4",       // 特征值，识别插件产物
    "key": "<容器关联键>",
    "kind": "preset" | "profile",
    "profileId": "<仅 kind=profile>",
    "profileName": "<仅 kind=profile>",
    "parentKey": "<仅 kind=profile，父节点 id>"
}
```

投影预设不含用户 profiles——它本身就是某条 profile 的实体化；`readMeta` 对其返回空容器。

## 2. 元数据容器（PresetMeta）

| 字段 | 类型 | 必有 | 说明 |
|---|---|---|---|
| `description` | string | ✓ | 预设描述（卡片页展示） |
| `models` | string[] | ✓ | 适用模型标签 |
| `profiles` | Profile[] | ✓ | 全部 v3 profiles（§3-§5），追加式，永不隐式去重 |
| `bgImage` | string | ✓ | 卡片背景图 URL |
| `defaultSnapshot` | SnapshotEntry[] | 迁移/新建后 | 出厂挂载基线，首次新建 Base 时幂等锁定 |
| `defaultSnapshotLocked` | boolean | 同上 | 区分旧版仅开关快照与新版含 `originalFields` 的全量基线 |
| `defaultSampling` | Sampling | 同上 | 出厂采样基线 |
| `defaultExtra` | object | 同上 | 出厂 extra 基线（排除连接/凭据键） |
| `defaultModel` | Model | 同上 | 出厂模型基线 |

四个 `default*` 基线是 reset 的回退锚点，也是 Base/Delta 值差异的比对基准；迁移时仅在目标未锁定基线时写入（`defaultSnapshotLocked !== true`），否则保留目标自己的基线。

## 3. Profile 公共头

Base 与 Delta 共有：`formatVersion: 3`、`kind: 'prompt_base' | 'prompt_delta'`、`id: string`（时间戳+随机后缀）、`name: string`。

## 4. 主配置（prompt_base）

```jsonc
{
    "formatVersion": 3,
    "kind": "prompt_base",
    "id": "1724400000000123",
    "name": "主配置",
    "prompts": [ { "identifier": "p1", "mounted": true, "enabled": true,
                   "lastActiveIndex": 0, "fields": { "content": "我的改法" } } ],
    "unusedIds": ["p4"],              // 可选：保存时未挂载引用，只记 identifier
    "sampling": { "temperature": 0.8 }, // 可选：相对出厂采样基线的 sparse diff
    "extra": {},                        // 可选：相对出厂 extra 基线的 sparse diff
    "model": { "source": "openai", "name": "gpt-x" }, // 可选：创建时的模型快照
    "extProfile": {}                    // 可选：扩展覆盖（§6）
}
```

- `prompts[]` 记录目标 `prompt_order` 中条目的完整挂载态；`fields` 只存**与出厂基线有差异**的值字段。
- 未挂载引用只进 `unusedIds`（drift 的「删 prompt → mounted:false」、detach 都落在这里），迁移按真实引用收集时会包含它们。

## 5. 派生配置（prompt_delta）

```jsonc
{
    "formatVersion": 3,
    "kind": "prompt_delta",
    "id": "...", "name": "战斗版",
    "baseId": "<父 profile id>",
    "changes": [ { "identifier": "p2", "mounted": false } ], // 相对父解析态的差异
    "order": ["p1", "p2"],            // 可选：完整挂载顺序，缺省继承父级
    "sampling": {}, "extra": {}, "model": {}, "extProfile": {}
}
```

Delta 可嵌套派生。加载 = 出厂基线 ⊕ 父链各层 sparse diff 依次叠加（防环保护）；`changes` 只存真正不同的键，无差异不写。

## 6. 值字段白名单

`PromptFields` 仅允许五键：`content` / `name` / `role` / `injection_position` / `injection_depth`。`order`（注入顺序）为内部字段，不随 profile 捕获。

## 7. 采样参数（PromptSampling）

可选键：`temperature` `top_p` `top_k` `top_a` `min_p` `frequency_penalty` `presence_penalty` `repetition_penalty` `seed` `n` `openai_max_context` `openai_max_tokens` `stream_openai` `show_thoughts`。布尔键：`stream_openai`（流式输出）/ `show_thoughts`（请求思维链）。加载时缺失的键保持预设当前值，不覆盖。

## 8. 扩展覆盖（extProfile）

profile 可记录预设 `extensions` 下第三方数据的开关与数组条目增删（正则脚本、SPreset 绑定、tavern_helper 脚本等），加载 profile 时一并应用：

```jsonc
{
    "extMounts":  { "<数组路径>": [ { "id": "<条目id>", "definition": {} } ] }, // 新增条目
    "extUnmounts":{ "<数组路径>": ["<条目id>"] },                             // 摘除
    "extToggles": { "regex_scripts.<id>.disabled": true, "...enabled": false } // 布尔开关
}
```

路径白名单见 `src/constants.ts`：数组路径 `EXT_ARRAY_PATHS`（`regex_scripts`、`SPreset.RegexBinding.regexes`、`tavern_helper.scripts`），布尔路径 `EXT_BOOLEAN_PATHS`。每次捕获全量重算，无差异自动删除该字段。

**加载语义**：三部分统一沿父链依次应用（祖先 → 自身）——`extToggles` 后写者胜；后代可摘除祖先挂载的条目；各层新增条目并存，**同 id 跨层重复挂载时后层定义原位覆盖前层（后写者胜）**。捕获侧相对**继承基线**（父预设 extensions ⊕ 祖先层覆盖，注册链路捕获用 `buildInheritedExtensionBaseline` 构造）全量重算：基线没有的条目记 mount、有的记 unmount、仅开关字段变化记 toggle、其余定义被改写整条重捕获为覆盖 mount。

## 9. 导出文件格式

导出统一为**完整 preset JSON**（4 空格缩进）：预设本体 + `extensions['preset_cards']`。脱敏剔除连接/凭据键（`reverse_proxy`、`proxy_password`、`custom_url` 及 `is_connection` 标记项）。单 profile 导出只保留该 profile 及其父链，并写入 `extensions.preset_cards.targetId`（字符串）。导入侧从同一字段提取 profiles 并入目标预设。

## 10. 迁移对格式的影响

预设更新迁移对目标格式的**设计写入**是追加 profiles：与目标已有 profile 冲突的 `id` 重分配并同步重映射 Delta 的 `baseId`；出厂基线仅目标未锁定时写入。开启「从来源预设带入」时还会追加目标缺失、且被迁移 profile 引用的 prompt 定义（含 `unusedIds` 形态），并合并 `extensions.regex_scripts`（uuid 或名称重叠时内容保留目标版、`disabled` 随来源，其余整条追加）。

> 状态（2026-08-26）：上述是格式契约与预期语义，不表示当前实验性实现已通过合并门。`feature/preset-migration` 尚有投影刷新门重入、孤立 Delta、无 id 正则匹配、锁定基线目标和顶层 sampling/extra/model 三方迁移等阻断项；未修复前不得据此假定所有输出都满足契约，也不应将该分支合并进 `dev-ts`。共享持久化 patch 竞态与活动扩展回灌已在非迁移修复轮关闭。

作者更新语义下「从来源预设带入 prompt 定义 / 正则」两项默认关闭（新版删除的条目保持引用跳过，不复活）。
