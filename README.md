# Preset Cards for SillyTavern

将 SillyTavern 的 Chat Completion 预设管理器扩展为卡片网格，并为每个预设提供 Base / Delta Prompt Manager 状态配置。

## 功能

- 卡片网格展示模型、采样参数、描述、标签和背景图，支持搜索、多选删除与简洁模式。
- Base profile 保存完整 Prompt Manager 状态：mounted、enabled、active order、unused prompts 和可选字段差异。
- Delta profile 保存相对父级的 membership、enabled、历史位置、字段和 active order 差异，支持多层派生。
- Profile 编辑器仅对当前 active Profile 显示入口，并将 prompts 分为“未使用 Prompts”和 active 列表。未使用组默认折叠；active 列表显示序号、拖拽把手与 On/Off。
- membership、enabled、字段编辑和顺序调整全部进入 staged state，Commit 时一次性持久化并替换目标 `prompt_order.order`。
- system/marker 不提供字段编辑、清除或 enabled 开关；可在确认提示后切换 active/unused，并可在 active preset 中参与顺序拖拽。
- 搜索期间禁用拖拽；unused 条目不显示 On/Off 或 active 序号，可直接激活；active 条目可移到 unused。
- global Prompt Manager 策略写入 `character_id=100001`；character 策略写入当前活动角色。
- profile 导入、单项导出和 `prompt_tree` 导入导出仅支持 `formatVersion: 3`。

## Mounted、Disabled 与 Unused

- `mounted: true, enabled: true`：已挂载并参与生成。
- `mounted: true, enabled: false`：已挂载，但运行时关闭；仍保留在 active order 中。
- `mounted: false`：unused，不存在于目标 `prompt_order.order`，不参与生成。保存的 `enabled` 只用于以后重新激活时恢复开关。

active 变为 unused 时会记录 `lastActiveIndex` 和当前 `enabled`。再次激活时优先恢复历史位置；位置越界或没有历史位置时追加到 active 末尾。membership 变化不会隐式修改 `enabled`。

## v3 数据格式

所有数据位于预设的 `extensions['preset_cards']`。

Base：

```json
{
  "formatVersion": 3,
  "kind": "prompt_base",
  "id": "...",
  "name": "...",
  "prompts": [
    {
      "identifier": "main",
      "mounted": true,
      "enabled": true,
      "lastActiveIndex": 0,
      "fields": { "content": "..." }
    }
  ]
}
```

Base 的 `prompts[]` 先按目标 active order 保存 mounted 项，再按预设 `prompts[]` 原顺序保存 unused 项。

Delta：

```json
{
  "formatVersion": 3,
  "kind": "prompt_delta",
  "id": "...",
  "name": "...",
  "baseId": "...",
  "changes": [
    {
      "identifier": "main",
      "mounted": false,
      "enabled": true,
      "lastActiveIndex": 0
    }
  ],
  "order": ["system", "jailbreak"]
}
```

`order` 只包含 mounted identifier，缺省表示继承父级顺序。值字段白名单为 `content / name / role / injection_position / injection_depth`。

## SPreset / Prompt Manager 对齐

读取运行时状态时以当前 Prompt Manager 策略的目标 `prompt_order` 为准。应用 Base 或 Delta 时会先恢复该 preset 的默认字段基线，再叠加 profile 字段，并完整替换目标 order，而不是只更新已有开关：

- profile 中未挂载的 prompt 会从目标 order 移除，但不会删除预设 `prompts[]` 定义。
- 当前预设新增、但旧 v3 profile 中不存在的 prompt 会视为 unused。
- SPreset 或 Prompt Manager 调整 mounted 状态和 active order 后，新建 Base 会按相同语义读取。

单条 On/Off 操作仍使用增量 `syncPromptOrder()`；完整 profile 应用使用 `replaceTargetPromptOrder()`。

## 旧格式

v1/v2 profile 不迁移、不应用、不显示，也不能派生、编辑或导出。它们会原样保留在 metadata 中，不会因保存其他 v3 profile 而被静默删除。

导入含 v1/v2 profile 的文件会明确拒绝，并提示手动重建。`prompt_tree` 导出会排除 metadata 中的旧 profile。

Profile 导入导出只保证同一个 preset 的不同状态之间互操作，不承诺跨 preset 迁移。导出文件携带的 `defaultSnapshot` 用于还原该 preset 的字段基线，导入时不会作为 profile 的额外字段持久化。

## 使用

1. 打开 Preset Cards，或运行 `/presetcards`。
2. 在卡片“配置快照”区域点击 `+` 新建 v3 Base。
3. 点击 profile 名称应用配置；点击铅笔进入编辑器。
4. 在 unused/active 间切换 membership，调整 On/Off、字段或 active 顺序。
5. 点击 Commit，选择更新当前 profile 或新建子 Delta。
6. Delta 重置回父级；Base 重置回首次创建 Base 时锁定的默认状态。

## 开发

| 命令 | 说明 |
|---|---|
| `npm test` | 运行纯状态单元测试 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run build` | Vite 生产构建，输出 `dist/index.js` |
| `npm run watch` | 开发模式监听构建 |

核心实现：`src/promptState.ts` 负责纯状态解析与 diff，`src/promptToggle.ts` 负责 SillyTavern 运行时读取和 order 替换，`src/profileEditor.ts` 负责 staged 编辑器，`src/importExport.ts` 负责 v3 导入导出。
