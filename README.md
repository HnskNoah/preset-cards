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
- **注册为原生预设（注册链路，2026-08 实现）**：profile 投影为 ST 原生预设出现在 ST 预设下拉，原生 UI 与其他扩展可直接切换；原生切换与卡片点击走同一钩子，激活永远是最新父链解析结果；启动 / reload 自动对账重注册。
- **原生编辑自动捕获（保存捕获）**：注册 profile 激活期间，用户在原生 PromptManager 里改值 / 开关 / 拖顺序 / 删条目 / 新增条目，保存后自动 diff 捕获回 profile delta——原生编辑不再丢改动，形成「编辑 → 捕获 → 下次激活还原同一状态」闭环。
- **扩展配置随 profile（扩展捕获）**：profile 可记录预设 extensions 的开关与数组条目增删（正则脚本、SPreset 绑定、tavern_helper 脚本等），加载 profile 时一并应用；在注册 profile 激活期间的扩展变更同样被自动捕获。加载时**沿父链依次应用**（祖先 → 自身）：开关后写者胜、后代可摘除祖先挂载的条目、各层新增并存。
- **预设更新迁移（rebase 式三方合并，v2 逐层重放）**：预设出新版按新预设导入后，卡片页头部「迁移配置」把旧预设的整棵 profile 树迁移到新版——未变条目直接复用、作者改过的自动跟随、你改过的保留；冲突在 profile 编辑器内图形化解决（左栏仅列冲突条目、右栏三方对照 + 手动编辑第四选项），每次裁决全量重放、上层解决可能增减下层冲突（rebase 语义），未解决完「应用迁移」置灰。条目匹配以 identifier 为主键、内容指纹兜底（id 变了内容没变自动重映射）；新条目默认跟随出厂挂载，顺序可选「保留我的 / 跟随新版」。**来源附带内容**：跨预设迁移可开「从来源预设带入」，把目标缺失的 prompt 定义（含未挂载引用）与来源预设正则一并带入——正则 uuid/名称重叠时内容保留目标版、开关状态随来源；默认关闭保持作者更新语义。迁移为纯拷贝，旧预设原样保留；落盘后新版预设上的 profiles 自动注册为原生预设投影。

## 安装与构建

```bash
npm install        # 安装依赖
npm run build      # 生产构建，输出 dist/index.js（sourcemap 已禁用）
npm run watch      # 开发模式，监听 src/ 变更自动重建
npm run typecheck  # TypeScript 类型检查（tsc --noEmit）
npm test           # 运行 vitest 单元测试
```

插件本体位于 `public/scripts/extensions/preset-cards/`（manifest 的 `js` 字段指向 `dist/index.js`，`hooks.activate` = `init`）。将整个插件目录放入 ST 的 `public/scripts/extensions/` 下，刷新并启动 ST 后即可在侧边栏看到 **Preset Cards** 入口（或使用 `/presetcards` 斜杠命令）。`init.ts` 在模块顶层自执行一次（守卫防重复），兼容 ShareTavern 等非生命周期加载模式（`extensionLifecycle: false` 时不调 manifest hooks 也能初始化）。

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

所有扩展数据存于预设对象的 `extensions['preset_cards']`（描述、适用模型、背景图、profiles、隐藏默认基准、出厂采样基线），通过 ST 的 `/api/presets/save` 持久化。完整字段级格式声明（两种容器形态、Base/Delta 全字段、扩展覆盖、导出文件形状）见 **[PROFILE_FORMAT.md](PROFILE_FORMAT.md)**。

- **Base（`formatVersion: 3`, `kind: 'prompt_base'`）**：`prompts[]` 为 `{ identifier, mounted, enabled, lastActiveIndex?, fields? }`，记录完整挂载状态与开关；可选 `unusedIds`（保存时未挂载的 identifier 集合）、`sampling`、`extra`、`model`。`fields` 只含「与出厂基线有差异」的值字段。
- **Delta（`formatVersion: 3`, `kind: 'prompt_delta'`）**：`{ baseId, changes[], order? }`，`changes` 为 `{ identifier, mounted?, enabled?, lastActiveIndex?, fields? }`，仅记录相对上级的差异，可嵌套；`order` 记录完整挂载顺序。
- **值字段白名单**：`content / name / role / injection_position / injection_depth`（`PROMPT_FIELD_KEYS`）；`order`（注入顺序）为内部字段，UI 不编辑、不随 profile 捕获。
- **sampling / extra / model 链式解析**：加载 = 出厂基线（`defaultSampling` / `defaultExtra` / `defaultModel`）⊕ 父链 sparse diff ⊕ 自身 diff；采集（新建 Base / derive / create-delta）只存真正不同的键，diff 为空不写。旧版全量快照文件按 sparse 叠加结果值相同，无需迁移。
- **扩展覆盖（`extProfile`，`ExtProfileOverride`）**：Base / Delta 均可携带，只存相对父预设 extensions 的差异——`extMounts`（新增的带 `id` 数组条目 + 定义）、`extUnmounts`（摘除的条目 id）、`extToggles`（布尔开关，含数组条目的 `disabled` / `enabled` 字段）。覆盖路径白名单见 `constants.ts` 的 `EXT_ARRAY_PATHS`（`regex_scripts`、`SPreset.RegexBinding.regexes`、`tavern_helper.scripts`）与 `EXT_BOOLEAN_PATHS`（`SPreset.ChatSquash.enabled`、`SPreset.MacroNest`）；每次捕获全量重算，无差异时该字段自动删除。
- **隐藏默认基准（`defaultSnapshot`）**：首次为该预设新建 Base 时幂等全量锁定，每条 prompt 记录 `{ identifier, mounted, enabled, lastActiveIndex?, originalFields }`（mounted 与 unused 均记录）。reset 时只还原出厂挂载的条目（`defaultEnabledEntries`），出厂值由 `originalFields` 还原到预设。
- **出厂采样基线（`defaultSampling`）与 extra 基线（`defaultExtra`）**：与 `defaultSnapshot` 同时锁定，reset 时还原预设采样键与 extra 字段到出厂值。extra 排除连接 / 凭据键（模型、来源、代理、endpoint 等 `is_connection` 字段）。
- **第三方自管理 prompt 排除**：`SPresetSettings` 等固定名 prompt 不进入 profile 快照（`PROMPT_NEVER_CAPTURE`）。

## 导入导出与旧版迁移

- **导入（已定稿实现，2026-08-14）**：两个入口，均并入 profiles——头部「导入预设」由插件接管文件读取并按类型分流：**完整 preset 文件**弹窗「并入现有预设（去重合并）/ 作为新预设导入（ST 原生还原）」，同名候选预设排在目标选择首位；**v3 profile 文件**（base / delta / prompt_tree）弹窗选择目标预设并入；**其余类型**（普通 ST 预设 / v1/v2 / 未知格式）回退 ST 原生导入。卡片「导入配置」为**手动并入**入口（目标 = 当前卡片预设，完整 preset 也只并 profiles）。**跨预设风险确认**：完整 preset 文件内预设名与目标预设名不同，或 v3 profile 无法确认来源预设时，会先弹「跨预设导入风险」确认窗，用户确认后才继续。**并入按内容指纹去重**：与现有（或本批已并入）条目内容相同（kind + 语义字段 + delta 父链指纹）的 profile 跳过并提示；同一预设分多次导出的不同 profile 可合并为同一棵树，共享父节点只并入一次。v3 载荷经 `assertV3ImportPayload` 校验；完整 preset JSON 经 `extractProfilesFromPresetExport` 提取。所有 profile 重新分配 id，`baseId` 重映射到有效 id；带内嵌父状态（`base.prompts`）的 delta 或孤立 delta 会生成本地 `Imported Parent` base 作为锚点（父内容与已有 profile 相同时直接挂到已有父）。文件内 profile id 重复会被拒绝导入（id 是重映射与父链指向的唯一锚点）。v1/v2 需先迁移（见下）。设计稿见本地 `docs/historical/import-flow-design.md`（docs/ 为本地 gitignore 目录，不入库；交接时需单独提供）。
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

## 注册链路（profile → ST 原生预设，已实现）

> 解决「profile 无法暴露给 ST 生态（原生 UI / 其他扩展）」的痛点：把 profile 投影为 ST 原生预设，切换从「字段级涂抹」变成「选中一个真预设」。v4 独立文件存储设计已废弃（设计稿存本地 `docs/archive/`，未消费模块已从源码树移除）。

- **投影 + marker**：profile 解析为全量快照 → `buildProjectedPreset` 投影为完整 ST preset 记录，身份 marker（`kind:'profile'` + profileId/profileName/parentKey）藏在 `extensions.preset_cards`；`readPresetMarker` 反查。
- **注册**：`openai_settings.push` + `openai_setting_names[注册名]=索引`，落盘走 `POST /api/presets/save`（ST 预设为文件型存储）；注册名唯一（占位规则 `父名 - profile名` + 数字后缀去重）。启动 / reload 时全量对账幂等重注册（服务端按预设文件重建数组后不丢投影）。**数据权威仍在父预设的 `extensions['preset_cards']`，注册记录只是投影拷贝**。
- **激活归一**：`OAI_PRESET_CHANGED_BEFORE` 钩子（ST 原生下拉与卡片点击都触发）读 marker → 沿父链重新解析 → **应用前**覆盖传入记录 + 写回存储，注册记录保持新鲜；**激活永远 = 最新父链解析结果**，父预设被原生编辑导致的过期靠此兜底。
- **观察者**：`PRESET_CHANGED` 只同步 activeProfile / 卡片高亮 / `onProfileChanged` 通知，绝不重复应用（ST 已应用）。
- **保存捕获**：`SETTINGS_UPDATED`（ST 保存落盘后触发；原生 PromptManager 每次编辑都以它收尾）diff 运行时 vs 注册记录 → 差异自动捕获回 profile delta。删除 = `mounted:false` + 材料留池；新增 = 定义入父预设 prompts 池 + delta 挂载条目；ST 列表 Remove（detach）识别为 unmounted 而非 enabled 漂移。顶层采样 / extra / 模型漂移按「运行时 vs profile 生效值」判定，回到继承基线时自动删除 override。无基线守卫（注册记录无 prompts 时跳过 prompt 漂移，防全量误捕获）；无差异零写入防重入。
- **扩展捕获**：注册 profile 激活期间，扩展（extensions）的布尔开关与数组条目增删 diff 运行时 vs 父预设 → 捕获为 `extProfile` 覆盖（见数据模型节）；加载 profile 时 `applyExtensions` 在预设 clone 上还原。
- **生命周期清理**：profile 删除 → 注销注册；父预设删除（含 `PRESET_DELETED` 事件与启动孤儿清扫）→ 注销名下全部注册，ST 下拉不留废项。

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
| `tests/presetStore.test.ts` / `tests/editorStore.test.ts` | core store 纯 reducer 与派生视图（卡片浏览态 / 编辑器 staged） |
| `tests/projection.test.ts` / `tests/storageMarker.test.ts` / `tests/coreTypes.test.ts` | 投影 preset / 身份 marker 读写 / 领域类型谓词 |
| `tests/registration.test.ts` | core/registration 纯函数：注册 / marker 反查 / 注销 / 按父查注册 / 变更检测重写 |
| `tests/presetRegistration.test.ts` | 注册适配层：快照构建与全量对账（启动 / reload 幂等）、PRESET_DELETED 清理与孤儿清扫、激活同步、投影激活时重应用运行时 |
| `tests/presetCapture.test.ts` | 保存捕获：捕获门与回写（captureIfRegistered / initPresetCapture）、ST 预设键↔设置键映射、顶层 sampling/extra/model override 捕获 |
| `tests/captureDrift.test.ts` | 保存捕获纯函数：computePromptDrift 漂移计算、applyPromptDriftToProfile（base / delta 回写） |
| `tests/extCapture.test.ts` | computeExtensionDrift：扩展 mount / unmount / toggle 与数组条目 enabled / disabled 漂移检测 |
| `tests/extApply.test.ts` | applyExtensions：扩展覆盖应用到预设 clone（摘除 / 新增 / 开关，含数组条目路径） |
| `tests/presetCardsState.test.ts` | `applyProfileToPresetByName` 持久化失败回滚 |
| `tests/presetMigration.test.ts` | 迁移适配层：视图构建 / 来源候选 / plan→execute 闭环（冲突 blocked→解决→落盘重锁基线+自动注册投影） |
| `tests/migrationPlan.test.ts` | 迁移 dry-run 纯函数：三级匹配 / 五类条目 / 字段级三方冲突 / dangling |
| `tests/migrationApply.test.ts` | 迁移应用纯函数：blocked 语义 / 三方合并净零 / 顺序策略 / 链感知净零 / 成环保守 |

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
| `src/presetRegistration.ts` | 注册链路适配层：openai_settings 注册表读写、全量对账（启动 / reload）、激活钩子与观察者、删除清理 |
| `src/presetCapture.ts` | 保存捕获（切片 3）：SETTINGS_UPDATED 门 + 漂移捕获回 profile + 材料留池 / 新增入父池 + 顶层采样 / extra / 模型漂移 + 扩展漂移 |
| `src/extCapture.ts` | 扩展漂移检测纯函数：运行时 vs 父预设 extensions 的 mount / unmount / toggle 差异 |
| `src/extApply.ts` | 扩展覆盖应用纯函数：`extProfile` 应用到预设 clone（摘除 / 新增 / 开关） |
| `src/presetMigration.ts` | 迁移适配层：预设对象 ↔ core/migration 视图、新出厂基线采集、追加式落盘（id 冲突重分配，落盘后注册链路自动投影） |
| `src/migrationDialog.ts` | 迁移向导 UI：选来源/目标 → dry-run 报告与策略选项 → 冲突三栏裁决 → 应用 |
| `src/presetBuffers.ts` | 会话编辑缓冲（`sessionEdits` / `pendingToggles`）的键管理与应用（纯数据，不接触 DOM） |
| `src/activeProfile.ts` | 当前激活 profile 引用（localStorage 持久化）、`getActiveProfile` |
| `src/presetSnapshot.ts` | defaultSnapshot 锁定 / 合并 / reset 基线 |
| `src/profileMutators.ts` / `src/profileActions.ts` | profile 数据变换与派生 / 级联删除 |
| `src/importExport.ts` / `src/profileSchema.ts` | 导入导出与 v3 载荷校验 |
| `src/presetList.ts` / `src/profileTree.ts` | 卡片与弹窗共用的条目视图、派生关系森林 |
| `src/nameWrap.ts` | 名字换行策略：`applyNameWrap` 消费 `presetList.ts` 的 `isRepeatedRunName`（超长重复串检测），对名字元素加 `.pc-name-nowrap` 保留省略号 |
| `src/editModal.ts` / `src/cache.ts` / `src/i18n.ts` / `src/constants.ts` | 编辑表单、背景图缓存、ST 语言判定 `L()`、中英词典、常量 |
| `src/core/domain/{types,schema}.ts` | 领域类型与 v3 形状谓词（meta.ts / profileSchema.ts 重导出） |
| `src/core/store/{PresetStore,EditorStore}.ts` | 卡片浏览态 store（P3 已接入）/ 编辑器 staged store（已挂载，交互未接入） |
| `src/core/codec/snapshotEntries.ts` | 快照 ↔ entries 转换（编辑器 / 注册链路用） |
| `src/core/storage/{project,marker}.ts` | profile 投影为 ST preset + 身份 marker（注册链路核心） |
| `src/core/registration/register.ts` | 注册链路纯函数：注册 / marker 反查 / 注销 / 变更检测（注册表与命名策略可注入） |
| `src/core/capture/drift.ts` | 保存捕获纯函数：prompt 级漂移计算与回写（fields / enabled / order / 删增 / 挂载态） |
| `src/core/migration/{plan,apply}.ts` | 预设更新迁移纯函数：dry-run 三方合并分析（三级匹配/冲突清单）+ 应用（基线重锁/id 重映射/净零/排序策略） |
| `tools/migrate-to-v3.ts` | v1/v2 → v3 迁移 CLI |
