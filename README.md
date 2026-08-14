# Preset Cards for SillyTavern

将 ST 原生的下拉式 Chat Completion 预设管理器重做为可视化卡片网格的第三方扩展，并为每个预设提供**主 / 派生 profile（Base / Delta）**两级配置快照系统。开发分支 `dev-ts`，发布分支 `ts`。

## 功能特性

- **卡片网格预览**：每张卡片显示名称、来源与模型、描述、适用模型标签、采样参数（Temperature / Top P / Top K / Context / Tokens）与背景图；按「当前激活优先、其余按名称」排序。
- **搜索 / 多选批量删除**：实时按名称或描述过滤；多选模式（Multi-Select）批量删除预设。
- **主 profile（Base，formatVersion 3）**：保存当前预设全部 prompt 的完整挂载状态快照（`mounted` / `enabled` / `lastActiveIndex` / `fields`），值字段按「与出厂基线（`defaultSnapshot.originalFields`）的差异」存储；首次新建 Base 时幂等锁定全量出厂基线（含采样与 extra 基线）。
- **派生 profile（Delta，formatVersion 3）**：只保存相对上级的差异（`changes`），支持嵌套派生（Delta 可再派 Delta），加载时递归解析父链叠加应用，带防环保护；`order` 字段记录完整挂载顺序。
- **Profile 编辑器弹窗**：点击卡片上的 profile 名称加载后自动打开（pcmanager 式左右栏）。左栏为 prompt 列表（1-based 序号、角色徽章、开关、清除值变更、拖拽把手），右栏默认「暂存更改（Staged）」diff，点条目进入单条内联编辑；全部改动先写会话缓冲，点顶部 **Commit** 统一落盘。**单向数据流**：编辑期间挂载 / 卸载 / 拖拽只改会话内 `sessionOrder`，不改 ST 的 `prompt_order`；仅在 Commit 成功后投影回预设、加载时物化到运行时。
- **拖拽重排**：重排通过 `profile.order` 纳入 staged diff，与开关 / 值编辑统一 Commit 落盘，支持逐条撤销；脏标记以弹窗打开时的原始顺序为基准，拖回原位自动清除。
- **system_prompt / marker 条目**：不显示开关与内容编辑入口（内容由 ST 管理），仅普通 prompt 可切换、可编辑；允许调整 mounted / unused，操作前必须确认。
- **内联值编辑**：编辑表单提供 Name、Role + Position（同一行）、Injection Depth（仅 position=2 显示）与全宽 Content 文本域；position 下拉含 **Relative(0) / In-chat(1) / In Chat Absolute Depth(2)**；marker 条目内容框禁用。值差异写入会话缓冲，仅记录净变化字段。
- **导入导出**：导出统一为「**完整 preset JSON**」（含预设本体 + `extensions['preset_cards']`，数据自动脱敏剔除连接 / 凭据字段）。三个导出入口行为：**卡片右上角 / 头部「导出全部配置文件」**导出该预设**全部** v3 profile；**单 profile「导出配置」**只导出该 profile **及其父链**（delta 需真实父链才能正确解析），父链外的 profile 不导出。导入目前双入口（头部 ST 原生还原 / 卡片并入 profiles）；已定稿改造为「头部按类型分流 + 卡片保留为手动并入」，见「导入导出与旧版迁移」节。v1/v2 需先用迁移工具转换（见下）。
- **重置**：Delta 回退到上级（Base 或上层 Delta），Base 回退到隐藏的默认基准（`defaultSnapshot`）。
- **Commit 二选一**：编辑器顶部的 Commit 让用户选择「更新当前配置」或「新建为子配置（派生）」；delta 更新的差异基线用**父链解析**（`resolveParentStates`），未编辑的已存差异原样保留。
- **清除值变更**：一键删除该条目的 `fields` 并**完全撤销**——同时还原运行时值、同步活动预设、清除本次会话编辑记录（`sessionEdits`）。
- **简洁模式（Concise Mode）**：压缩卡片；简洁模式下长按卡片弹出该预设的 profile 列表快速切换。
- **派生 / 重命名 / 删除（级联）**：profile 支持派生、行内重命名与删除；删除时递归收集全部派生后代并确认后级联删除。
- **元数据编辑**：描述、适用模型标签（渲染厂商 Logo）、背景图 URL，支持背景图 IndexedDB 缓存与一键清理。
- **锁定态只读查看**：锁定后隐藏重置 / 提交按钮，点击 prompt 可进入只读查看（表单禁用、无保存），取消按钮显示为返回。
- **中文界面**：`L()` 用 ST 的 `getCurrentLocale()` 判定语言（回退链 = `localStorage['language']` → `navigator.language` → `en`，与 ST 完全一致），命中内置中英词典即切换中文；未显式设置语言时也跟随浏览器语言，不会默认误判英文。

## 安装与构建

```bash
npm install        # 安装依赖
npm run build      # 生产构建，输出 dist/index.js（sourcemap 已禁用）
npm run watch      # 开发模式，监听 src/ 变更自动重建
npm run typecheck  # TypeScript 类型检查（tsc --noEmit）
npm test           # 运行 vitest 单元测试
```

插件本体位于 `public/scripts/extensions/preset-cards/`（manifest 的 `js` 字段指向 `dist/index.js`，`hooks.activate` = `init`）。将整个插件目录放入 ST 的 `public/scripts/extensions/` 下，刷新并启动 ST 后即可在侧边栏看到 **Preset Cards** 入口（或使用 `/presetcards` 斜杠命令）。

## 使用说明

1. **打开**：侧边栏点击 **Preset Cards**，或运行 `/presetcards`。
2. **新建主 profile**：卡片「配置快照」区点击 `+`，输入名称，保存当前 `prompt_order.order` 中已挂载 prompt 的开关为 Base（首次自动锁定全量出厂基线）。
3. **新建派生 profile**：在某条 profile 上点击派生图标，输入名称，得到一份相对上级的 Delta；此后可在其上编辑开关 / 值后再覆盖更新。
4. **编辑 profile**：点击 profile 名称，加载后自动打开 **Profile 编辑器**。左栏逐条切换开关、清除值变更或拖拽排序；点击条目在右栏编辑 content / name / role / position（+ 注入深度），改动先进「暂存更改」。
5. **Commit**：点顶部 Commit，选择「更新当前配置」直接写回，或「新建为子配置」把当前状态保存为新的 Delta；关弹窗时有未提交改动会弹「丢弃」确认，确认后缓冲清除。
6. **清除值变更**：有值差异的条目显示清除按钮，一键撤销该条目的值编辑（含本次会话记录与运行时值）。
7. **重置**：点重置图标确认后，Delta 回退到父级、Base 回退到默认基准。
8. **顺序调整**：仅活动预设可在编辑器左栏拖拽条目把手重排，与开关 / 值编辑统一纳入 staged diff，Commit 时落盘。

## 数据模型

所有扩展数据存于预设对象的 `extensions['preset_cards']`（描述、适用模型、背景图、profiles、隐藏默认基准、出厂采样基线），通过 ST 的 `/api/presets/save` 持久化。

- **Base（`formatVersion: 3`, `kind: 'prompt_base'`）**：`prompts[]` 为 `{ identifier, mounted, enabled, lastActiveIndex?, fields? }`，记录完整挂载状态与开关；可选 `unusedIds`（保存时未挂载的 identifier 集合）、`sampling`、`extra`、`model`。`fields` 只含「与出厂基线有差异」的值字段。
- **Delta（`formatVersion: 3`, `kind: 'prompt_delta'`）**：`{ baseId, changes[], order? }`，`changes` 为 `{ identifier, mounted?, enabled?, lastActiveIndex?, fields? }`，仅记录相对上级的差异，可嵌套；`order` 记录完整挂载顺序。
- **值字段白名单**：`content / name / role / injection_position / injection_depth`（`PROMPT_FIELD_KEYS`）；`order`（注入顺序）为内部字段，UI 不编辑、不随 profile 捕获。
- **sampling / extra / model 链式解析**：加载 = 出厂基线（`defaultSampling` / `defaultExtra` / `defaultModel`）⊕ 父链 sparse diff ⊕ 自身 diff；采集（新建 Base / derive / create-delta）只存真正不同的键，diff 为空不写。旧版全量快照文件按 sparse 叠加结果值相同，无需迁移。
- **隐藏默认基准（`defaultSnapshot`）**：首次为该预设新建 Base 时幂等全量锁定，每条 prompt 记录 `{ identifier, mounted, enabled, lastActiveIndex?, originalFields }`（mounted 与 unused 均记录）。reset 时只还原出厂挂载的条目（`defaultEnabledEntries`），出厂值由 `originalFields` 还原到预设。
- **出厂采样基线（`defaultSampling`）与 extra 基线（`defaultExtra`）**：与 `defaultSnapshot` 同时锁定，reset 时还原预设采样键与 extra 字段到出厂值。extra 排除连接 / 凭据键（模型、来源、代理、endpoint 等 `is_connection` 字段）。
- **第三方自管理 prompt 排除**：`SPresetSettings` 等固定名 prompt 不进入 profile 快照（`PROMPT_NEVER_CAPTURE`）。

## 导入导出与旧版迁移

- **导入（现状）**：两个入口，均并入 profiles——头部「导入预设」由插件接管文件读取并按类型分流：**完整 preset 文件**弹窗「并入现有预设（去重合并）/ 作为新预设导入（ST 原生还原）」，同名候选预设排在目标选择首位；**v3 profile 文件**（base / delta / prompt_tree）弹窗选择目标预设并入；**其余类型**（普通 ST 预设 / v1/v2 / 未知格式）回退 ST 原生导入。卡片「导入配置」为**手动并入**入口（目标 = 当前卡片预设，完整 preset 也只并 profiles）。**并入按内容指纹去重**：与现有（或本批已并入）条目内容相同（kind + 语义字段 + delta 父链指纹）的 profile 跳过并提示；同一预设分多次导出的不同 profile 可合并为同一棵树，共享父节点只并入一次。v3 载荷经 `assertV3ImportPayload` 校验；完整 preset JSON 经 `extractProfilesFromPresetExport` 提取。所有 profile 重新分配 id，`baseId` 重映射到有效 id；带内嵌父状态（`base.prompts`）的 delta 或孤立 delta 会生成本地 `Imported Parent` base 作为锚点（父内容与已有 profile 相同时直接挂到已有父）。v1/v2 需先迁移（见下）。
- **导入（定稿已实现，2026-08-14）**：头部「导入预设」已由插件接管文件读取，按类型分流——完整 preset 弹窗并入或新建 / v3 profile 弹窗选预设并入 / 其余回退 ST 原生；卡片「导入配置」保留为**手动并入**入口（完整 preset 也接受，但明确只并 profiles）。设计稿见 `docs/current/architecture.md` 与 `docs/plans/import-flow-design.md`（docs/ 本地 gitignore，不入库；向新接手者交接时需口头/单独提供这些文件）。
- **导出**：统一为导出完整 preset JSON（`exportPresetFile`），脱敏剔除 reverse_proxy / proxy_password / custom_url / azure / workers_ai 等连接与凭据字段。**卡片右上角 / 头部「导出全部」**导出全部 profiles；**单 profile「导出配置」**只导出该 profile 及其父链（`collectAncestorProfileIds`），父链外 profile 不导出。导入侧从该 JSON 的 `extensions['preset_cards']` 提取 profiles 并入当前预设。
- **v1 / v2 迁移**：旧版 profile 文件**不会**在导入时自动迁移，需先用独立工具转换：

  ```bash
  npx tsx tools/migrate-to-v3.ts input.json              # 输出 input.v3.json
  npx tsx tools/migrate-to-v3.ts input.json -o out.json # 指定输出路径
  npx tsx tools/migrate-to-v3.ts --dir ./backup         # 批量转换目录下所有 .json
  ```

  支持 v1 全量快照、v2 base/delta、含 v2 内部条目的 `prompt_tree`、纯预设本体等格式。**完整 preset JSON**（含 `extensions['preset_cards']`）：profiles 全部为 v3 时原样透传（保证导入/导出前后体验一致）；含 v1/v2 profiles 时仅迁移旧条目，预设本体与 v3 条目保留。

## 与 ST 集成的已知注意点

- `prompt_order` **按预设存储**：ST 原生在切换预设时仅在 `preset[key] !== undefined` 时才复制（`openai.js` `onSettingsPresetChange`），否则保留上一个预设的值。
- **插件已缓解（两条切换路径归一）**：卡片切换（`fastApplyPreset`）与 ST 原生「AI 响应配置」下拉（`OAI_PRESET_CHANGED_BEFORE` 监听）在预设缺 `prompts` / `prompt_order` 时，都会先把运行时值清为 `undefined`，让 `PromptManager.sanitizeServiceSettings`（`OAI_PRESET_CHANGED_AFTER` 触发）重建 ST 默认 prompts / 默认顺序，避免继承上一个预设的顺序 / 开关。
- **既定语义（非缺陷）**：「更新当前配置 / 拖拽重排 / 新建 Base」仍按「保存当前运行时状态」写回该预设（ST 的 `getChatCompletionPreset` 全量含 `prompts` / `prompt_order`）；在完成上述继承缓解后，此刻的运行时顺序 / 开关即为该预设自身的正确状态。

## 第三方集成（对外 API）

preset-cards 通过 `window.presetCards` 向其他 SillyTavern 扩展暴露集成接口，便于在自定义场景（便捷方案、快捷回复、宏等）中加载 / 查询 profile。类型声明见 `src/types/presetCardsApi.d.ts`。

```ts
interface PresetCardsApi {
    loadProfile(presetName: string, profileId: string): Promise<boolean>;
    getProfiles(presetName: string): { id: string; name: string }[];
    getProfileModel(presetName: string, profileId: string): { source: string; name: string } | undefined;
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

> **新架构定稿（未实施，见 `docs/current/architecture.md` 本地文档）**：对外 API 将升级为 `listProfiles(presetName?)`（返回带 `presetName` + `profileName` 的 `ProfileRef[]`）与「切换并激活」语义的 `loadProfile`（加载 + 持久化 + 切 ST 当前预设 + 记 active + 发事件），`onProfileChanged` 回调参数同步升级。当前代码仍为上方旧 API。

## 开发约定

仓库根有 **`AGENTS.md`**（开发 / CI / 分支 / PR 工作流）与 **`CODING_GUIDELINES.md`**（文件规模阈值、context 对象、纯函数下沉、防循环依赖等）。**审查结论复核流程**：任何 review / audit 结论须先独立判定 `REAL` / `MARGINAL` / `FALSE`（附 file:line 证据，能复现则写 harness）方可执行。`AGENTS.md` / `CODING_GUIDELINES.md` / `UNFIXED_ISSUES.md` 与 `docs/` 目录均有意加入 `.gitignore`——本地交接文档不随仓库跟踪；已知未修问题见 `UNFIXED_ISSUES.md`（同为本地文件）。新 agent 接盘需随仓库目录一起取得这些本地文件。

## 测试覆盖

单元测试用 vitest（纯逻辑，无浏览器）。测试文件按被测模块命名，位于 `tests/`，依赖 `tests/mocks/` 下的 ST 全局模拟。跑全部：`npm test`；单文件：`npx vitest run tests/<file>.test.ts`。

| 测试文件 | 覆盖 |
|---|---|
| `tests/metaPersist.test.ts` | `readMeta` / `saveMeta` 持久化串行链与合并窗口 |
| `tests/profileActions.test.ts` | profile 派生 / 级联删除 / 父链收集（`collectAncestorProfileIds`） |
| `tests/profileChain.test.ts` | delta 父链解析、防环、Imported Parent 锚点 |
| `tests/profileEditorState.test.ts` | 编辑器状态 / 会话缓冲 / 撤销恢复 |
| `tests/profileResetApply.test.ts` | reset 回退（Delta→父级 / Base→defaultSnapshot） |
| `tests/profileSchema.test.ts` | v3 载荷 schema 校验（`assertV3ImportPayload`） |
| `tests/profileTree.test.ts` | 派生关系森林 / 条目视图构建 |
| `tests/promptCapture.test.ts` | 值字段白名单、采样 / extra / 模型捕获与应用 |
| `tests/promptState.test.ts` | 挂载状态快照 / delta 差异 / 顺序重排 |
| `tests/importExport.test.ts` | 导入导出：`extractProfilesFromPresetExport` / `mergeImportedProfiles` / 完整 preset 提取 |
| `tests/migrate-to-v3.test.ts` | v1/v2 → v3 迁移工具 |
| `tests/i18n.test.ts` | `L()` 语言判定：显式 zh/en、浏览器语言回退（`navigator.language`）、词典缺键 |
| `tests/nameWrap.test.ts` | `isRepeatedRunName`：重复字符串检测阈值、空白忽略 |
| `tests/profileEditorContext.test.ts` | `buildBreadcrumb` / `truncateBreadcrumbName`：父链折叠、名字压缩、防环 |

> 新增逻辑（尤其纯数据变换层）应尽量作为纯函数测试，而非 DOM 弹窗测试；mocks 提供 `addPreset` 等辅助注册预设。

## 源码结构

| 文件 | 职责 |
|---|---|
| `src/index.ts` / `src/init.ts` | 扩展入口、斜杠命令、`window.presetCards` 暴露 |
| `src/presetCards.ts` / `presetCardsContext.ts` / `presetCardsState.ts` / `presetCardsHandlers.ts` / `presetCardsRender.ts` | 卡片页弹窗（打开 / 状态 / 事件 / 局部刷新；`presetCardsState.ts` 含 `onProfileChanged` 事件源，覆盖所有加载路径） |
| `src/profileEditor.ts` / `profileEditorContext.ts` / `profileEditorState.ts` / `profileEditorHandlers.ts` / `profileEditorRender.ts` | 编辑器弹窗五件套 |
| `src/meta.ts` | 元数据类型、`readMeta` / `saveMeta`（含保存串行链与合并窗口） |
| `src/promptState.ts` | 挂载状态快照 / delta 差异 / 顺序重排纯函数 |
| `src/promptCapture.ts` | 值字段白名单、采样 / extra / 模型快照采集与应用 |
| `src/promptApply.ts` / `src/promptToggle.ts` / `src/promptOrder.ts` | profile 应用、prompt_order 同步与替换 |
| `src/fastApply.ts` | 快捷应用预设：绕过 ST 原生逐元素同步 reflow，批量直写内存 + DOM，触发与原生一致的事件链 |
| `src/presetBuffers.ts` | 会话编辑缓冲（`sessionEdits` / `pendingToggles`）的键管理与应用（纯数据，不接触 DOM） |
| `src/activeProfile.ts` | 当前激活 profile 引用（localStorage 持久化）、`getActiveProfile` |
| `src/presetSnapshot.ts` | defaultSnapshot 锁定 / 合并 / reset 基线 |
| `src/profileMutators.ts` / `src/profileActions.ts` | profile 数据变换与派生 / 级联删除 |
| `src/importExport.ts` / `src/profileSchema.ts` | 导入导出与 v3 载荷校验 |
| `src/presetList.ts` / `src/profileTree.ts` | 卡片与弹窗共用的条目视图、派生关系森林 |
| `src/nameWrap.ts` | 名字换行策略：`applyNameWrap` 消费 `presetList.ts` 的 `isRepeatedRunName`（超长重复串检测），对名字元素加 `.pc-name-nowrap` 保留省略号 |
| `src/editModal.ts` / `src/cache.ts` / `src/i18n.ts` / `src/constants.ts` | 编辑表单、背景图缓存、ST 语言判定 `L()`、中英词典、常量 |
| `tools/migrate-to-v3.ts` | v1/v2 → v3 迁移 CLI |
