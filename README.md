# Preset Cards for SillyTavern

将 ST 原生的下拉式 Chat Completion 预设管理器重做为可视化卡片网格的第三方扩展，并为每个预设提供**主/派生 profile（Base / Delta）**两级配置快照系统。当前开发分支 `feature/profile-editor`，提交范围 `9c95aa1→77a743b`。

## 功能特性

- **卡片网格预览**：每张卡片显示名称、来源与模型、描述、适用模型标签、采样参数（Temperature / Top P / Top K / Context / Tokens）与背景图；按「当前激活优先、其余按名称」排序。
- **搜索 / 多选批量删除**：实时按名称或描述过滤；多选模式（Multi-Select）批量删除预设。
- **主 profile（Base）**：保存当前预设全部 prompt 的开关状态快照（`enabled`），值字段按「与出厂基线（defaultSnapshot）的差异」存储（`{ identifier, enabled, fields? }`，仅存有差异的白名单字段）；首次新建 Base 时幂等全量锁定出厂基线。
- **派生 profile（Delta）**：只保存相对上级的差异（`changes`），支持嵌套派生（Delta 可再派 Delta），加载时递归解析父链叠加应用，带防环保护。
- **Profile 编辑器弹窗**：点击卡片上的 profile 名称加载后自动打开（pcmanager 式左右栏，`src/profileEditor.ts` + `profile-editor.html`）。左栏为 prompt 列表（1-based 序号、角色徽章、开关、清除值变更、拖拽把手），右栏默认「暂存更改（Staged）」diff，点条目进入单条内联编辑；全部改动先写会话缓冲，点顶部 **Commit** 统一落盘。
- **拖拽重排**：仅活动预设的条目可拖（搜索中禁用）；重排立即写入 `prompt_order` 并保存、不进暂存 diff；脏标记以弹窗打开时的原始顺序为基准，拖回原位自动清除；序号在重渲染前保持原值。
- **system_prompt / marker 条目不显示开关与编辑入口**：这些条目的内容由 ST 管理，仅普通 prompt 可切换、可编辑。
- **点击条目编辑值**：编辑表单（`src/editModal.ts` 的 `buildPromptEditForm`，弹窗与右栏内联共用）提供 Name、Role + Position（同一行）、Injection Depth（仅 position=2 显示）与全宽 Content 文本域；position 下拉含 **Relative(0) / In-chat(1) / In Chat Absolute Depth(2)**；marker 条目的内容框禁用。值差异写入会话缓冲，仅记录净变化字段。
- **prompt 顺序拖拽**：重排能力已并入编辑器弹窗左栏拖拽（见上），卡片行不再渲染上移/下移按钮；写入目标策略感知（global→100001 / character→活动角色 id）。
- **导入导出**：profile 导出弹窗三选项——「导出」（自包含旧格式，delta 附解析后的父快照 `Imported Parent`）、「包含关系链的导出」（`prompt_tree` 导出该预设**全部** base/delta，DFS 根优先排序保证每个 delta 的 baseId 祖先在其前，保留原始 id/baseId，v1 排除）、「取消」；完整预设导出刻意不进该弹窗（用 ST 自带）。配置区块头部有 3 个同尺寸小图标按钮——**导入 / 导出全部 / 加号**，任一视口均半透明 0.5；「导出全部」经两选项「导出全部配置文件 / 取消」确认后下载整棵分支树（`${name}-tree.json`）；卡片右上角 `.preset_card_export_btn` 为完整预设导出（剔除敏感连接字段，`.json`），与全树导出区分。导入识别 `prompt_tree`（root→leaf 重建、`targetId` 命名匹配、内容与 `fields` 白名单均相同的 base 自动复用、idMap 覆盖 base 与 delta、freshId 去重）与旧版 base / delta / v1 格式。
- **重置**：Delta 回退到上级（Base 或上层 Delta），Base 回退到隐藏的默认基准（`defaultSnapshot`，首次新建 Base 时自动锁定）。
- **Commit 二选一**：编辑器弹窗顶部的 Commit 弹窗让用户选择「更新当前配置」或「新建为子配置（派生）」；delta 更新的差异基线用**父链解析**（`resolveParentStates`），未编辑的已存差异原样保留。
- **清除值变更**：一键删除该条目的 `fields` 并**完全撤销**——同时还原运行时值、同步活动预设、清除本次会话的编辑记录（`sessionEdits`）。
- **简洁模式（Concise Mode）**：压缩卡片；简洁模式下长按卡片弹出该预设的 profile 列表快速切换。
- **派生 / 重命名 / 删除（级联）**：profile 支持派生、行内重命名与删除；删除时递归收集全部派生后代（delta 的 delta），确认弹窗列出将一并删除的节点；「覆盖为当前设置」由弹窗 Commit →「更新当前配置」承担（原卡片行保存按钮已移除）。
- **元数据编辑**：描述、适用模型标签（渲染厂商 Logo）、背景图 URL，支持背景图 IndexedDB 缓存与一键清理。
- **中文界面**：读取 ST 全局语言设置自动切换中英文（内置中英词典，无需改动 ST 的 i18n）。

## 安装与构建

```bash
npm install        # 安装依赖
npm run build      # 生产构建，输出 dist/index.js（sourcemap 已禁用）
```

插件本体位于 `public/scripts/extensions/preset-cards/`（manifest 的 `js` 字段指向 `dist/index.js`，`hooks.activate` = `init`）。将整个插件目录放入 ST 的 `public/scripts/extensions/` 下，刷新并启动 ST 后即可在侧边栏看到 **Preset Cards** 入口（或使用 `/presetcards` 斜杠命令）。

## 使用说明

1. **打开**：侧边栏点击 **Preset Cards**，或运行 `/presetcards`。
2. **新建主 profile**：卡片「配置快照」区点击 `+`，输入名称，保存当前 `prompt_order.order` 中已挂载 prompt 的开关为 Base（首次自动锁定全量出厂基线）。
3. **新建派生 profile**：在某条 profile 上点击派生图标（fork），输入名称，得到一份相对上级的 Delta；此后可在其上编辑开关/值后再覆盖更新。
4. **编辑 profile**：点击 profile 名称，加载后自动打开 **Profile 编辑器**弹窗。左栏逐条切换开关、清除值变更或拖拽排序；点击条目在右栏编辑 content / name / role / position（+ 注入深度），改动先进「暂存更改」。
5. **Commit**：点弹窗顶部 Commit，选择「更新当前配置」直接写回，或「新建为子配置」把当前状态保存为新的 Delta；关弹窗时有未提交改动会弹「丢弃」确认，确认后缓冲清除。
6. **清除值变更**：有值差异的条目显示清除按钮，一键撤销该条目的值编辑（含本次会话记录与运行时值）。
7. **重置**：点重置图标确认后，Delta 回退到父级、Base 回退到默认基准。
8. **顺序调整**：仅活动预设可在编辑器左栏拖拽条目把手重排 `prompt_order`（不改变开关与 `prompts[]` 顺序，立即保存、不进暂存）。

## 数据说明

- 所有扩展数据存于预设对象的 `extensions['preset_cards']`（描述、适用模型、背景图、profiles、隐藏默认基准），通过 ST 的 `/api/presets/save` 持久化。
- **Base（`formatVersion: 2`, `kind: 'prompt_base'`）**：`prompts[]` 为 `{ identifier, enabled, fields? }`，只保存当前 `prompt_order.order` 中已挂载 prompt 的开关快照，`fields` 只含「与出厂基线有差异」的值字段。
- **Delta（`formatVersion: 2`, `kind: 'prompt_delta'`）**：`{ baseId, changes[] }`，`changes` 为 `{ identifier, enabled?, fields? }`，仅记录相对上级的差异，可嵌套。
- **值字段白名单**：`content / name / role / injection_position / injection_depth`（`PROMPT_FIELD_WHITELIST`）；`injection_order` 仍为内部字段，UI 不编辑、不随 profile 捕获，避免加载 profile 时用旧快照覆盖用户后续调整的注入值。
- **隐藏默认基准（`defaultSnapshot`）**：首次为该预设新建 Base 时幂等全量锁定（`{ identifier, enabled?, originalFields }`）。全部 prompt 保存字段基线，只有当时 mounted 的 prompt 保存开关；unused 不推断默认开关，reset 时保持不变。
- 另有旧版 v1 全量快照（`settings` 深拷贝）用于向后兼容，不可派生。
- 读取 profile 快照开关时使用当前目标 `prompt_order` 条目（global 为 character_id=100001，character 为活动角色）；reset 的隐藏默认基线读取 global 条目，缺失表示 unused/未知，不回退 `prompts[].enabled`，也不修改该 prompt 的开关。

## 与 ST 集成的已知注意点

- `prompt_order` **按预设存储**：切换到**没有** `prompt_order` 键的预设时，ST 会继承上一个预设的顺序（仅在 key 存在时才复制）。
- 在活动预设上「更新当前配置 / 拖拽重排」会把这类继承来的顺序/开关**永久写进**该预设——该风险已记录在案，尚未在代码中缓解。

## 开发

| 命令 | 说明 |
|---|---|
| `npm run build` | 生产构建（Vite，sourcemap 关闭，输出 `dist/index.js`） |
| `npm run watch` | 开发模式，监听 `src/` 变更自动重建（`--mode development`） |
| `npm run typecheck` | 仅做 TypeScript 类型检查（`tsc --noEmit`） |

源码入口为 `src/index.ts`（重导出 `src/init.ts` 的 `init` 钩子），核心逻辑见 `src/presetCards.ts`（卡片页 handler）、`src/profileEditor.ts`（profile 编辑器弹窗）、`src/promptToggle.ts`（profile 应用 / prompt_order 同步）、`src/meta.ts`（元数据读写）、`src/presetList.ts`（卡片与弹窗共用的条目视图）；会话缓冲与派生构造见 `src/presetBuffers.ts`、`src/presetSnapshot.ts`、`src/profileActions.ts`，导入导出见 `src/importExport.ts`，编辑表单见 `src/editModal.ts`，中英词典见 `src/constants.ts`。仓库根有 **`AGENTS.md`**，固化开发约定与**审查结论复核流程**——任何 review/audit 结论须先由独立 verify 判定 `REAL` / `MARGINAL` / `FALSE`（附 file:line 证据）方可执行。`docs/` 目录有意加入 `.gitignore`，设计文档不随仓库跟踪。

## 最近变更（分支 `feature/profile-editor`，9c95aa1→77a743b）

- **Profile 编辑器弹窗**（7dc8c0b→77a743b）：点击 profile 名加载后自动打开 pcmanager 式左右栏编辑器（`src/profileEditor.ts` + `profile-editor.html`）。左栏 prompt 列表（1-based 序号、角色徽章、隐藏 identifier、开关、清除值变更、拖拽把手），右栏默认「暂存更改」diff（开关/值变更逐条 Undo），点条目或「查看暂存」进入内联编辑表单；顶部 **Commit** 统一落盘（更新当前配置 / 新建为子配置），关弹窗有未提交改动时弹「丢弃」确认，确认后缓冲清除（重新加载会整体覆盖 preset，无续编路径）。手机端（≤768px）右栏默认隐藏，点条目后右栏全宽覆盖列表。
- **拖拽重排 + 脏标记**（0b257ee、4c3ec99）：仅活动预设可拖（搜索中禁用）；重排立即写入 `prompt_order` 并保存、**不进暂存 diff**；脏标记以弹窗打开时的原始顺序为基准（`initialOrderIndex`），拖回原位自动清除；序号在下次重渲染前保持原值。
- **移除卡片行保存按钮**（77a743b）：保存统一走弹窗 Commit（原「覆盖为当前设置」floppy 保存按钮与 `.preset_card_profile_update` handler 删除）。
- **injection_depth 入白名单**（7dc8c0b）：`PROMPT_FIELD_WHITELIST` 扩为 content / name / role / injection_position / injection_depth；编辑表单 Position 新增「In Chat Absolute Depth(2)」，选中时显示注入深度 number 输入。
- **全预设锁定基线**（1f39053）：首次为该预设 add base 时幂等全量锁定 `defaultSnapshot`（含 `originalFields`）；base 改按「与基线差异」存储 content（`buildBaseSnapshotDiff`）；移除打开面板批量回填，reset 有可靠出厂基线。
- **模块化拆分 + 公共例程**（b84e42e、8054ec3）：presetCards.ts 拆分出 presetBuffers / presetDirty / presetSnapshot / profileActions；抽取 `commitBufferedEditsToProfile`（统一 base/delta 提交，父链缺失 full-changes 全量回退 vs abort 报错）与 `deletePresetByName` 删除例程（单删/批删统一）。
- **级联删除**（f5494f5）：删除 profile 时递归收集全部派生后代（delta 的 delta，visited 防环），确认弹窗列出将一并删除的节点名。
- **导出带出厂基线 + 导入坐标系迁移**（46fc0c5）：base/delta/整树导出附带 defaultSnapshot（文件基线）；导入时文件基线与本地基线建「桥」base（bridgeBase，本地基线+桥=文件基线），导入 profile 一律转 delta 挂桥下，本地基线不覆盖。
- **条目开关/值编辑缓冲化 + 双色标记**（daf3141、417fbad）：点击/开关不再即时写预设，统一进 sessionEdits / pendingToggles 会话缓冲，Commit 时 `applyBufferedEdits` 落盘；条目持久差异（琥珀 persistent）与会话未保存差异（青蓝 dirty）双色高亮，重渲染后按缓冲恢复。
- **defaultSnapshot 惰性记录原始字段**（f0520b1、f8d62da）：编辑条目的原始值字段惰性写入 defaultSnapshot.originalFields，reset 时还原到首次编辑前状态。
- 另见前文功能/数据/开发段：配置区块头部三按钮、全树导出与 prompt_tree 导入、AGENTS.md 复核流程、缓冲键长度前缀编码等。
