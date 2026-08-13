# preset-cards 开发约定

SillyTavern 插件（TypeScript）。简体中文交流；Windows PowerShell 7；构建：`npm run typecheck`（必须零错误）+ `npm run build`（产出 dist/index.js）。

## 分支与产物

- 功能开发在独立分支（如 `feature/profile-changelist`、`feature/import-export`），完成并验证后推送。
- `dist/index.js` 由 vite 构建（sourcemap 已关闭）。**dev-ts 不跟踪 dist（`.gitignore` > dist/）**；debug push：CI 检测源码变更后构建，typecheck + patch 递增 + 打 `vX.Y.Z-Debug` tag；release：推 `vX.Y.Z` release tag，CI 从 tag 源码构建并同步 dist + 静态资源到 `ts`。
- `docs/` 目录已 gitignore，仅作本地设计记录，不提交。README.md 提交并维护。

## CI / GitHub Actions（自动化约定）

`.github/workflows/` 下三个工作流：

- **check.yaml**：PR 到 `dev-ts` 时 `npm ci` + `npm run typecheck`，合并前质量门（必须通过）。
- **bundle.yaml**：监听 `dev-ts` 分支 push 与 `v*` tag push。dev-ts push（debug）：CI 检测源码变更后 build（否则仅 typecheck）+ patch 递增 + 打 `vX.Y.Z-Debug` tag，不发布。release tag push（`vX.Y.Z`，不含 `-Debug`）：CI 从 tag 源码构建并同步 dist + 静态资源到 `ts`；debug tag push 跳过。
- **bump_deps.yaml**：每 3 天 `npm update` 自动升级依赖并 bot 提交（`[bot] Bump deps`）。

发版：创建 release tag（`git tag v1.2.3 && git push origin v1.2.3`），由 CI 构建并同步 `ts`；不要用提交信息里的 `[release]` 触发。

## 领域背景（快速上手）

- profile 存于 `preset.extensions['preset_cards']`（`readMeta`/`saveMeta`，saveMeta POST 整预设到 /api/presets/save）。
- `PromptBaseProfile`（formatVersion 3）= 全量 Prompt Manager 状态（mounted / enabled / lastActiveIndex / fields）；`PromptDeltaProfile` = 相对父链的差异（`baseId` + `changes` + 可选 mounted `order`，支持 delta 派 delta）。旧 v1/v2 仅原样保留在 metadata，不显示、不应用、不导入。
- 运行时状态在目标 `prompt_order` 条目（global 策略 character_id===100001，character 策略为活动角色）；单条开关仍用 `syncPromptOrder`，Base/Delta 完整应用必须用 `replaceTargetPromptOrder` 替换目标 order。
- 值字段白名单：content / name / role / injection_position / injection_depth（order 刻意不暴露；injection_depth 随 profile 捕获/应用，加载 profile 时可能用快照值覆盖用户当前注入深度——此为刻意的「对齐上游 profile-editor」特性）。
- system_prompt / marker 条目不显示字段编辑、清除与 enabled 开关；允许调整 mounted/unused，但操作前必须确认；活动预设中允许参与顺序拖拽。
- profile 编辑入口只对当前 active Profile 显示；其他 Profile 不得进入 profile editor。
- 加载 Base/Delta 时先恢复该预设 `defaultSnapshot.originalFields`，再叠加 profile 的 sparse fields，确保重复加载结果一致。
- 激活预设编辑时**不得触发 `#update_oai_preset`**（会用旧 oai_settings 覆盖内存编辑，R2）；保存后调 `refreshActivePresetUI`。
- `mirrorFieldsToActivePreset` 直接改 oai_settings.prompts 是必要的 ST workaround（R2 防御），保留。
- 全树导出 `prompt_tree`：只收集 v3 base/delta，DFS 根先序（保证 delta 祖先在前），保留 mounted、lastActiveIndex、order 与原始 id/baseId；v1/v2 不导出。

## 审查结论复核流程（必须执行）

任何 review / audit / 代码质量评审产出的结论，**不得照单全收**，必须先经过独立复核再决定执行：

1. review/audit subagent 产出的每个 claim（bug / 建议 / 风险）都可能是错的、过时的或不可达的。
2. 用**独立 verify subagent** 逐个验证：
   - 判定 `REAL`（真缺陷，值得修）/ `MARGINAL`（理论成立但实际不可达/可忽略）/ `FALSE`。
   - 必须给出 file:line 证据；能复现的场景尽量写临时 harness 复现。
   - 无法复现就明确说「无法复现」，不许猜测。
3. 只有 `REAL` 的才执行修复；`MARGINAL` 说明理由后可不做；`FALSE` 丢弃。
4. 复核还要检查审计是否**漏报**（如 idMap 不记 delta 导致的断链）。
5. 每次验证产出 verdict 表，逐项记录判定与证据，作为执行依据。

## gh / GitHub CLI 代理须知

本机 Windows 系统代理为 `127.0.0.1:6478`，但 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量未设置，gh 会报 `You appear to be using a proxy, but your proxy environment variables are not set.`

- **任何 gh 命令前**，先设置会话级代理变量（只影响当前 shell，不污染系统/用户级环境）：
  `$env:HTTPS_PROXY="http://127.0.0.1:6478"; $env:HTTP_PROXY="http://127.0.0.1:6478"`
- 若代理端口变化，先 `Test-NetConnection 127.0.0.1 -Port <port> -InformationLevel Quiet` 探测，再按实际端口设置。

## PR 与分支同步工作流（固定）

分支模型：`dev-ts` 为主开发分支；`ts` = dev-ts + 上游 `upstream/ts` 同步；功能/修复在独立分支（如 `fix`、`feature/*`）。`origin` = HnskNoah/preset-cards（fork），`upstream` = Aruki-Myu/preset-cards（官方）。

功能完成后的发布流程（每次 PR 都按此走）：

1. **先推 dev-ts 基线**：若本地 dev-ts 领先 `origin/dev-ts`（含 upstream merge 等），先 `git push origin dev-ts`——否则 PR 差异会把 upstream merge 内容也带进去。
2. `git push origin <功能分支>`。
3. 建 PR（gh 必须指定 `--repo`，多 remote 下短命令会解析到错误仓库）：
   `gh pr create --repo HnskNoah/preset-cards --base dev-ts --head <功能分支> --title "..." --body "..."`
4. **等 check.yaml typecheck 通过**后合并（保留提交，与仓库既有 PR 习惯一致，勿 squash）：
   `gh pr merge <n> --repo HnskNoah/preset-cards --merge`
5. 本地同步 dev-ts：`git checkout dev-ts && git pull origin dev-ts`
6. **发布**（仅需时）：确认 `dev-ts` 已含目标改动后，打 release tag（`git tag vX.Y.Z && git push origin vX.Y.Z`）。CI 会从 tag 构建并自动同步产物到 `ts`。
7. **ts 同步（debug 或未发版）**：dev-ts 合并完成后**不要自动**执行 ts 同步，必须停下来询问用户是否需要同步：
   `git checkout ts && git merge origin/dev-ts && git push origin ts`

> 若 `gh pr create` 报 `Head sha can't be blank / No commits between`，先 `git fetch origin` 确认远程 ref 已更新再重试；仍失败则加 `--repo HnskNoah/preset-cards`。

## 提交信息风格

中文，前缀如 `feat:` / `fix:` / `refactor:` / `style:` / `docs:` / `chore:`，简明描述改动。只在用户明确要求时提交/推送。

- **commit message 禁止出现内部审计/审查词汇**：如 `F1`-`Fn`、`R1`-`Rn`、`audit`、`REAL`/`MARGINAL`/`FALSE`、`verdict`、`review` 等编号或术语；一律用用户可读的中文描述实际改动内容。
