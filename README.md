# Preset Cards for SillyTavern

将 ST 原生的下拉式 Chat Completion 预设管理器重做为可视化卡片网格的第三方扩展，并为每个预设提供**主/派生 profile（Base / Delta）**两级配置快照系统。当前开发分支 `dev-ts`。

## 功能特性

- **卡片网格预览**：每张卡片显示名称、来源与模型、描述、适用模型标签、采样参数（Temperature / Top P / Top K / Context / Tokens）与背景图；按「当前激活优先、其余按名称」排序。
- **搜索 / 多选批量删除**：实时按名称或描述过滤；多选模式（Multi-Select）批量删除预设。
- **主 profile（Base，formatVersion 3）**：保存当前预设全部 prompt 的完整挂载状态快照（`mounted` / `enabled` / `lastActiveIndex` / `fields`），值字段按「与出厂基线（defaultSnapshot）的差异」存储；首次新建 Base 时幂等全量锁定出厂基线（含采样与 extra 字段）。
- **派生 profile（Delta，formatVersion 3）**：只保存相对上级的差异（`changes`），支持嵌套派生（Delta 可再派 Delta），加载时递归解析父链叠加应用，带防环保护。支持 `order` 字段记录完整挂载顺序。
- **Profile 编辑器弹窗**：点击卡片上的 profile 名称加载后自动打开（pcmanager 式左右栏，`src/profileEditor.ts` + `profile-editor.html`）。左栏为 prompt 列表（1-based 序号、角色徽章、开关、清除值变更、拖拽把手），右栏默认「暂存更改（Staged）」diff，点条目进入单条内联编辑；全部改动先写会话缓冲，点顶部 **Commit** 统一落盘。
- **拖拽重排**：重排通过 `profile.order` 纳入 staged diff，与开关/值编辑统一 Commit 落盘，支持逐条撤销；脏标记以弹窗打开时的原始顺序为基准，拖回原位自动清除。
- **system_prompt / marker 条目不显示开关与编辑入口**：这些条目的内容由 ST 管理，仅普通 prompt 可切换、可编辑；允许调整 mounted/unused，操作前必须确认。
- **点击条目编辑值**：编辑表单提供 Name、Role + Position（同一行）、Injection Depth（仅 position=2 显示）与全宽 Content 文本域；position 下拉含 **Relative(0) / In-chat(1) / In Chat Absolute Depth(2)**；marker 条目的内容框禁用。值差异写入会话缓冲，仅记录净变化字段。
- **导入导出**：profile 导出弹窗三选项——「导出」（自包含格式，delta 附解析后的父快照 `Imported Parent`）、「包含关系链的导出」（`prompt_tree` 导出该预设**全部** v3 base/delta，DFS 根优先排序保证每个 delta 的 baseId 祖先在其前，保留原始 id/baseId，v1 排除）、「取消」；完整预设导出刻意不进该弹窗（用 ST 自带）。配置区块头部有 3 个同尺寸小图标按钮——**导入 / 导出全部 / 加号**；「导出全部」经确认后下载整棵分支树（`${name}-tree.json`）；卡片右上角 `.preset_card_export_btn` 为完整预设导出。导入使用 archive base 机制（隐藏坐标系锚点），识别 `prompt_tree` 与旧版 base / delta / v1 格式，v1/v2 自动迁移到 v3。
- **重置**：Delta 回退到上级（Base 或上层 Delta），Base 回退到隐藏的默认基准（`defaultSnapshot`，首次新建 Base 时自动锁定，含采样与 extra 基线）。
- **Commit 二选一**：编辑器弹窗顶部的 Commit 弹窗让用户选择「更新当前配置」或「新建为子配置（派生）」；delta 更新的差异基线用**父链解析**（`resolveParentStates`），未编辑的已存差异原样保留。
- **清除值变更**：一键删除该条目的 `fields` 并**完全撤销**——同时还原运行时值、同步活动预设、清除本次会话的编辑记录（`sessionEdits`）。
- **简洁模式（Concise Mode）**：压缩卡片；简洁模式下长按卡片弹出该预设的 profile 列表快速切换。
- **派生 / 重命名 / 删除（级联）**：profile 支持派生、行内重命名与删除；删除时递归收集全部派生后代（delta 的 delta），确认弹窗列出将一并删除的节点；「覆盖为当前设置」由弹窗 Commit →「更新当前配置」承担（原卡片行保存按钮已移除）。
- **元数据编辑**：描述、适用模型标签（渲染厂商 Logo）、背景图 URL，支持背景图 IndexedDB 缓存与一键清理。
- **锁定态只读查看**：锁定后隐藏重置/提交按钮，点击 prompt 可进入只读查看（表单控件禁用、无保存），取消按钮显示为返回。
- **中文界面**：读取 ST 全局语言设置自动切换中英文（内置中英词典，无需改动 ST 的 i18n）。

## 安装与构建

```bash
npm install        # 安装依赖
npm run build      # 生产构建，输出 dist/index.js（sourcemap 已禁用）
npm run watch      # 开发模式，监听 src/ 变更自动重建
npm run typecheck  # TypeScript 类型检查（tsc --noEmit）
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
8. **顺序调整**：仅活动预设可在编辑器左栏拖拽条目把手重排，与开关/值编辑统一纳入 staged diff，Commit 时落盘。

## 数据说明

- 所有扩展数据存于预设对象的 `extensions['preset_cards']`（描述、适用模型、背景图、profiles、隐藏默认基准、出厂采样基线），通过 ST 的 `/api/presets/save` 持久化。
- **Base（`formatVersion: 3`, `kind: 'prompt_base'`）**：`prompts[]` 为 `{ identifier, mounted, enabled, lastActiveIndex?, fields? }`，记录完整挂载状态与开关。可选 `unusedIds`、`sampling`、`extra`。`fields` 只含「与出厂基线有差异」的值字段。
- **Delta（`formatVersion: 3`, `kind: 'prompt_delta'`）**：`{ baseId, changes[], order? }`，`changes` 为 `{ identifier, mounted?, enabled?, lastActiveIndex?, fields? }`，仅记录相对上级的差异，可嵌套。`order` 记录完整挂载顺序。
- **值字段白名单**：`content / name / role / injection_position / injection_depth`（`PROMPT_FIELD_KEYS`）；`injection_order` 为内部字段，不随 profile 捕获。
- **隐藏默认基准（`defaultSnapshot`）**：首次为该预设新建 Base 时幂等全量锁定（`{ identifier, mounted, enabled, lastActiveIndex?, originalFields }`）。全部 prompt 保存字段基线，只有当时 mounted 的 prompt 保存开关；unused 不推断默认开关，reset 时保持不变。
- **出厂采样基线（`defaultSampling`）与 extra 基线（`defaultExtra`）**：与 defaultSnapshot 同时锁定，reset 时还原预设采样键和 extra 字段到出厂值。
- **导入存档 base（`archiveBaseId`）**：导入 v1/v2/v3 数据时生成的隐藏 base，作为坐标系锚点，不显示在树中，最后一个子节点删除时级联删除。
- 旧版 v1 全量快照（`settings` 深拷贝）在打开面板时自动迁移到 v3；v2 profile 同样迁移。

## 与 ST 集成的已知注意点

- `prompt_order` **按预设存储**：切换到**没有** `prompt_order` 键的预设时，ST 会继承上一个预设的顺序（仅在 key 存在时才复制）。
- 在活动预设上「更新当前配置 / 拖拽重排」会把这类继承来的顺序/开关**永久写进**该预设——该风险已记录在案，尚未在代码中缓解。

## 第三方集成（对外 API）

preset-cards 通过 `window.presetCards` 向其他 SillyTavern 扩展暴露集成接口，便于在自定义场景（便捷方案、快捷回复、宏等）中加载/查询 profile。类型声明见 `src/types/presetCardsApi.d.ts`。

```ts
interface PresetCardsApi {
    loadProfile(presetName: string, profileId: string): Promise<boolean>;
    getProfiles(presetName: string): { id: string; name: string }[];
    listPresets(): string[];
    getActiveProfile(): { presetName: string; profileId: string } | undefined;
    onProfileChanged(listener: (ref: { presetName: string; profileId: string }) => void): () => void;
}
```

使用示例：
```js
await window.presetCards.loadProfile('我的预设', 'profile-id');
const unsubscribe = window.presetCards.onProfileChanged(({ presetName, profileId }) => {
    console.log('profile 已加载', presetName, profileId);
});
```

`onProfileChanged` 覆盖**所有**加载路径（卡片行、concise、`loadProfile`），第三方据此同步 UI。

## 开发约定

仓库根有 **`AGENTS.md`**，固化开发约定与**审查结论复核流程**——任何 review/audit 结论须先由独立 verify 判定 `REAL` / `MARGINAL` / `FALSE`（附 file:line 证据）方可执行。`docs/` 目录有意加入 `.gitignore`，设计文档不随仓库跟踪。

## 最近变更

- **v3 profile 模型升级**：formatVersion 3，新增 mounted/unused/order/archive 挂载态、sampling/extra 基线快照
- **Staged diff 统一暂存**：拖拽重排纳入 staged，与开关/值编辑统一 Commit 落盘，支持逐条撤销
- **锁定态只读查看**：锁定后隐藏重置/提交按钮，仅可浏览与返回
- **保存合并窗口**：连续 commit 300ms 窗口内合并保存，高频提交不再逐次全量 POST
- **搜索防抖与范围收窄**：搜索仅遍历主列表卡片，不再波及 staged 区；输入防抖 120ms
- **未激活条目激活警告**：激活未使用 prompt 前弹出可用性警告
- **v2 落盘迁移**：打开面板时 v2 profile 自动迁移到 v3
- **模块化拆分**：presetCards / profileEditor 拆分为 Context / State / Render / Handlers 五件套

源码入口为 `src/index.ts`，核心见 `src/presetCards.ts`（卡片页弹窗）、`src/presetCardsState.ts`（卡片页状态与操作）、`src/presetCardsHandlers.ts`（卡片页事件绑定）、`src/profileEditor.ts`（编辑器弹窗）、`src/profileEditorState.ts`（编辑器状态）、`src/profileEditorHandlers.ts`（编辑器事件）、`src/importExport.ts`（导入导出）、`src/editModal.ts`（编辑表单）、`src/meta.ts`（元数据读写）、`src/promptToggle.ts`（profile 应用 / prompt_order 同步）、`src/presetList.ts`（卡片与弹窗共用的条目视图）、`src/constants.ts`（中英词典）。