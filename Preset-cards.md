# Preset Cards for SillyTavern

**Preset Cards** 是一款专为 SillyTavern (ST) 开发的第三方扩展。它旨在通过**可视化卡片、子配置快照（Profiles）管理以及模型适配标签**等现代 UI 设计，彻底重构 ST 原生的下拉式预设管理器，为用户（尤其是经常切换不同模型或测试不同参数的进阶玩家）提供一套“精密仪器”般的高效工作流。

---

## 🌟 核心特性 (Key Features)

1. **可视化卡片网格 (Visual Grid Layout)**
   - 彻底摒弃了繁琐的长列表下拉框。
   - 所有预设以具有深度阴影、内发光、悬浮动画的卡片形式排列。
   - 支持实时文本过滤搜索（Search）、多选批量删除（Batch Delete）。

2. **子配置快照系统 (Profiles / Configurations)**
   - **痛点解决**：以往用户为了微调参数（如 Temperature 或 惩罚值）不得不新建无数个极其相似的预设。
   - **实现机制**：现在用户可以在单一“预设卡片”下无限创建 **子配置（Profiles）**。每个子配置都是当前参数状态的一份深拷贝快照。
   - **一键切换**：点击快照即可在几百毫秒内覆盖当前参数。
   - **自动保存**：在进行覆盖更新或新建时，自动触发 ST 的底层保存机制以捕获最新的界面数据。

3. **模型适配标签 (Model Compatibility Metadata)**
   - 预设经常是为特定的模型（如 GPT-4, Claude-3, 各种开源模型）调优的。
   - 用户可以在编辑面板中勾选该预设适用的模型，界面会直接渲染精美的厂商 Logo（Svg/Png），一目了然。

4. **无缝导入与导出 (Import & Export)**
   - 支持不仅导出完整的预设，还支持精准导出单个**子配置 (Profile)**。
   - 导出过程中自动进行数据脱敏（剥离反向代理 URL、API Keys 等敏感信息）。

5. **无侵入的自适应本地化 (Zero-intrusion I18n)**
   - 原生内置中英双语（English / 简体中文）。
   - 直接监听 ST 的全局语言设定（读取 `localStorage`），无需修改 ST 核心的 `i18n.json` 即可实现全界面（包含 Template 和 Toast）的自动语言切换。

6. **极致兼容性设计 (Third-Party Installation Proof)**
   - 针对 GitHub 下载解压后放入 `third-party` 目录导致的深层级路径（404 错误）问题，项目采用了**绝对路径根注入**以及基于 `import.meta.url` 的**动态扩展名解析**，保证在任何奇怪的安装路径下都能完美加载。

---

## 🏗️ 架构与文件结构 (Architecture & File Structure)

此扩展采用原生 ES6 Modules 开发，严格遵循 SillyTavern 的前端扩展规范。

```text
preset-cards/
├── manifest.json       // 扩展元数据，向 ST 声明加载顺序 (loading_order) 及入口文件
├── package.json        // 构建脚本与依赖 (Vite + TypeScript)
├── tsconfig.json       // TypeScript 编译配置
├── vite.config.ts      // Vite 构建配置 (@sillytavern/* 外部化解析)
├── src/                // TypeScript 源码 (Controller & Model)
│   ├── index.ts        // 入口，导出 init() 钩子
│   ├── constants.ts    // 常量：扩展名/LOGO/本地化字典/模型与来源映射
│   ├── i18n.ts         // 本地化助手 L()
│   ├── cache.ts        // IndexedDB 背景图缓存
│   ├── meta.ts         // 预设元数据读写 (readMeta/saveMeta)
│   ├── presetList.ts   // 视图模型构建 (buildPresetList)
│   ├── editModal.ts    // 元数据编辑弹窗 (openEditModal)
│   ├── presetCards.ts  // 主弹窗逻辑 (openPresetCards)
│   ├── init.ts         // 侧栏按钮与 /presetcards 斜杠命令
│   ├── globals.d.ts    // 全局变量声明
│   └── types/st.d.ts   // SillyTavern 模块自包含类型声明
├── dist/               // 构建产物 (Vite 输出，提交进 git)
├── style.css           // UI 视觉样式 (View - CSS)
├── cards.html          // 预设卡片网格的 Handlebars 模板 (View - HTML)
├── edit.html           // 元数据/模型标签编辑弹窗的 Handlebars 模板
├── Preset-cards.md     // 项目详细说明文档
└── llm-logos/          // 存放各主流模型厂商的 SVG/PNG 标志文件
```

### 构建 (Build)

源码使用 TypeScript + Vite 编写，构建后输出到 `dist/index.js`（manifest 的 `js` 字段即指向它）。仓库中的 `dist/` 已提交，普通用户直接安装即可使用，无需本地构建。

```bash
npm install        # 安装依赖
npm run build      # 生产构建 (输出 dist/index.js)
npm run watch      # 开发模式：监听 src/ 变更自动重建
npm run typecheck  # 仅做类型检查 (tsc --noEmit)
```

---

## ⚙️ 核心模块实现细节 (Implementation Details)

### 1. 动态路径与模块加载 (Dynamic Module Resolution)
为了解决第三方拓展目录 (`third-party`) 带来的模块相对路径解析崩溃问题，源码统一使用 ST 生态的 `@sillytavern/*` 引入惯例，构建时由 Vite 的 resolver 重写为 ST 虚拟服务器的**绝对根目录 (`/`) 模式**：
```typescript
import { openai_settings } from '@sillytavern/scripts/openai';
// 构建后等价于: import { openai_settings } from '/scripts/openai.js';
```
同时，为了准确定位 `llm-logos` 图片和 `cards.html` 模板，代码中通过 `import.meta.url` 动态解析了插件的真实名称，防范了用户乱改文件夹名字引发的 BUG（正则已兼容 `dist/` 子目录产物）：
```typescript
let EXTENSION_NAME = 'preset-cards';
const url = new URL(import.meta.url);
const match = url.pathname.match(/\/scripts\/extensions\/(.*?)\/(?:dist\/)?index\.js/);
if (match) EXTENSION_NAME = match[1];
```

### 2. 数据持久化机制 (Metadata Persistence)
ST 将文本生成的参数统一存储在 `openai_settings` 对象数组中。为了不破坏 ST 的原生数据结构，此扩展的所有专属数据（描述、适配模型、子配置快照）都被**隔离包裹**在每个预设的 `extensions['preset-cards']` 字段内。

`src/meta.ts` 提供了高度封装的读写辅助函数：
- `readMeta(preset)`: 尝试读取 `preset.extensions[EXTENSION_KEY]`，如果不存在则返回一套带默认值的骨架结构。
- `saveMeta(name, index, meta)`: 将修改后的 `meta` 数据写入到对应的 `openai_settings` 索引中，并调用 ST 原生的 `/api/presets/save` 端点将其持久化到硬盘，防止重启丢失。

### 3. 子配置快照算法 (Profile Snapshot System)
**子配置**实际上是整个预设对象除 `extensions` 之外所有键值对的 JSON 序列化深拷贝（Deep Clone）。
- **生成快照**：
  ```javascript
  const snapshot = structuredClone(preset);
  delete snapshot.extensions; // 防止出现嵌套噩梦 (Nested Recursion)
  profile.settings = snapshot;
  ```
- **加载快照**：
  在用户点击某个配置时，系统会提取当前的扩展数据，使用 `Object.assign()` 将快照的参数拍（Merge）进原生设置，然后再把扩展数据塞回去，最后触发 `#settings_preset_openai` 的 `change` 事件让 ST 原生 UI 做出响应并重渲染参数面板。

### 4. 界面渲染与事件代理 (Rendering & Event Delegation)
扩展采用了类似于 MVVM 的单向数据流思路：
1. `buildPresetList()` 读取所有可用预设，结合它们的 metadata，组装为一个巨大的上下文对象（Context Array）。
2. 将这个对象传递给 ST 的 `renderExtensionTemplateAsync(EXTENSION_NAME, 'cards', context)`，利用 Handlebars 进行渲染。
3. 渲染输出的 HTML 被注入到弹窗（Popup）中。
4. **事件代理 (Event Delegation)**：所有卡片交互（点击、删除、新增）**没有**绑定在每一个 DOM 节点上，而是统一绑定在最外层的 `dialog` 容器上（例如 `dialog.on('click', '.preset_card_profile_delete', ...)`）。这意味着无论是搜索导致的过滤还是新增配置导致的局部 DOM 刷新，都无需重新挂载事件监听器，极大地提升了性能和代码健壮性。

### 5. 多设备自适应与前端美学 (Responsive Design & Aesthetics)
`style.css` 在设计上着重体现“精密仪器”质感：
- 大量运用了 CSS Variables (`var(--SmartTheme...)`)，完美继承 ST 当前的主题颜色，不突兀。
- 使用 `rgba(..., 0.15)` 构建悬浮特效（Hover effects），配合 `box-shadow` 内阴影，营造下凹与浮现的三维层次。
- **移动端适配 (@media queries)**：针对触摸屏（没有鼠标悬浮事件），专门编写了 `@media (hover: none) and (pointer: coarse)` 媒体查询，将原本隐藏在 Hover 状态下的操作按钮强制显示，并运用负边距（Margin/Padding Trick）偷偷放大了可触控区域，防止移动端用户的“胖手指”误触。
