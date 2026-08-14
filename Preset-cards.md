# Preset Cards for SillyTavern

> **本文档为项目历史说明（旧版保留），当前实现以 [README.md](./README.md) 为准。**
> 数据模型、导入导出、源码结构、ST 集成注意点等权威描述见 README；本文件仅补充历史背景与设计动机，避免重复维护导致失真。

**Preset Cards** 是一款专为 SillyTavern (ST) 开发的第三方扩展。它通过**可视化卡片网格**重构 ST 原生的下拉式 Chat Completion 预设管理器，并为每个预设提供**主 / 派生 profile（Base / Delta）**两级配置快照系统，让进阶玩家在多模型 / 多参数场景下高效管理与切换。

## 设计动机（为何存在这个扩展）

- **ST 原生预设管理的痛点**：为微调参数（如 Temperature、惩罚值）必须新建无数个极其相似的预设，切换靠长下拉列表，无法快速比对。
- **本扩展的答案**：一张卡片对应一个预设，卡片下可挂任意数量的 **Base（全量挂载快照）** 与 **Delta（相对父级差异）** profile，点击即切换；派生关系形成树，重置时回退到父级或出厂基线。

## 核心概念速览（详见 README「数据模型」）

| 概念 | 说明 |
|---|---|
| Base（`formatVersion: 3`, `kind: 'prompt_base'`） | 预设全部 prompt 的完整挂载状态快照（`mounted` / `enabled` / `lastActiveIndex` / `fields`），值字段按「与出厂基线的差异」稀疏存储；可选 `sampling` / `extra` / `model` |
| Delta（`formatVersion: 3`, `kind: 'prompt_delta'`） | 相对上级的差异（`baseId` + `changes` + 可选 `order`），支持嵌套派生；加载时递归解析父链 |
| `defaultSnapshot` / `defaultSampling` / `defaultExtra` / `defaultModel` | 首次新建 Base 时幂等锁定的出厂基线，reset 时还原 |
| `extensions['preset_cards']` | 全部扩展数据存放处（描述 / 模型标签 / 背景图 / profiles / 出厂基线），经 ST `/api/presets/save` 持久化 |

## 架构演进（历史，供理解现状）

- **v1（原生 JS）**：早期实现，profile 为「整个预设对象深拷贝快照」存于 `profile.settings`，加载时 `Object.assign` 拍回设置——无 Base/Delta 派生、无稀疏差异。
- **v2**：引入 base/delta 概念，但为全量快照 / 非稀疏差异存储。
- **v3（当前，TypeScript + Vite）**：重构为模块化 TS 架构（`src/` 下按职责拆分，见 README「源码结构」），引入稀疏差异、父链解析、Profile 编辑器、会话缓冲单向数据流。**v1/v2 旧数据仅原样保留在 metadata，不显示、不应用、不导入**；旧文件须用 `tools/migrate-to-v3.ts` 转换。
- **当前实现已包含**：Profile 编辑器弹窗、会话缓冲（`sessionEdits`）+ Commit 落盘、拖拽重排纳入 staged diff、`defaultSnapshot` 出厂基线、快捷应用路径 `fastApply.ts`、对外 API `window.presetCards`、名字自动换行（超长重复串保留省略号）、面包屑祖先链压缩折叠、`L()` 跟随 ST 语言回退链。这些在 README「功能特性」「第三方集成」均有完整描述。

## 构建与安装

```bash
npm install        # 安装依赖
npm run build      # 生产构建，输出 dist/index.js（sourcemap 已禁用）
npm run watch      # 开发模式，监听 src/ 变更自动重建
npm run typecheck  # TypeScript 类型检查（tsc --noEmit）
npm test           # 运行 vitest 单元测试
```

插件本体位于 `public/scripts/extensions/preset-cards/`（manifest 的 `js` 字段指向 `dist/index.js`）。开发分支 `dev-ts`（dist 由 debug CI 构建提交，勿手改），发布分支 `ts`。完整开发 / CI / 分支 / PR 工作流见 **AGENTS.md**（本地文件，gitignore）。

## 本地文档清单（均 gitignore，仅存本地）

| 文件 | 用途 |
|---|---|
| `AGENTS.md` | 开发 / CI / 分支 / PR / gh 代理约定（命令级） |
| `CODING_GUIDELINES.md` | 代码结构与可维护性规范（规模阈值 / context 对象 / 纯函数下沉 / 防循环依赖） |
| `UNFIXED_ISSUES.md` | 未修 bug 归档（无法写入 GitHub issue #39，token 只读） |
| `docs/` | 本地设计记录（如 `docs/import-flow-design.md` 统一导入设计稿） |

> 交接新 agent 时，以上本地文档须随仓库目录一并提供（不入库）。
