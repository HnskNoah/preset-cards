# preset-cards 未修 bug 归档（无法写入 GitHub issue #39，token 只读）

> 目标：追加到 https://github.com/HnskNoah/preset-cards/issues/39
> 失败：`gh issue comment` / `gh api PATCH` 均 403（token 无 comment/edit 权限）
> 需用户手动追加或升级 token 后重试。

## 架构收敛轮（单向数据流 / 持久化统一 / sparse diff）闭合项

以下历史略过项随本轮架构改动自然闭合：

- C/N3/J/N [拖拽与 restore/unmount 的内存/磁盘分歧族]：编辑期不再直改 ST 的 `prompt_order`（会话 `sessionOrder` 为唯一真值源），`restoreOrderIfUncommitted` / `saveMetaWithCleanOrder` 整组防御代码删除 → 全部闭合。
- V. [挂载确认取消残留空 order 列表]：不再创建目标 order 列表 → 闭合。
- M/Q. [restoreOrderIfUncommitted 相关]：函数已删除 → 闭合。
- R7 N1 / R9 N2 [commit 失败运行时污染]：副作用全部后置于持久化成功之后 + 编辑期零写入，剩余面（applyBufferedEdits 成功路径后无失败点）已不可达 → 闭合。
- 持久化双机制（全局串行链 + 300ms 合并窗口）统一为 per-preset 合并窗口 + 串行尾链，消除两套实现的交互面。

## 清尾轮（issue 略过区最后一批）

- L. 挂载净零检测参照错误：改为 profile 解析态（`resolveProfileMountedMap`），未知条目回退 initialOrder。
- Y. re-entrancy：`ctx.committing` 守卫 commit/reset/close。
- Z. clear 后 undo 无法恢复：`clearedEdits` 快照 session + toggle，undo clear 时恢复。
- W. sortable 覆盖 unused 组：`items` 收紧为直接子级 `> .pc-prompt-card`。
- F. commit 后 render 抛错：finalizeEditorSession 的 render/refresh 包 try/catch。
- AC. chip label 注入：改 text 节点渲染。
- AB. editModal 字段先改后存：by-design 闭合（幂等收敛）。
- R. 会话中切角色错位：不可达闭合（模态弹窗阻挡 + 编辑期零写入）。

剩余开放（issue 留档）：H（delta 模型无法表达删除字段，enhancement）、AA（reset 失败重试收敛）。

## R7 轮归档（D7 略过项）

### N1 [MEDIUM/REAL] commit 失败后运行时 preset 已改写，discard 只还原 order 不还原 prompts
- 位置：`profileEditorHandlers.ts` commit handler（applyBufferedAndSnapshot 在 try 外执行）；`presetBuffers.ts` applyBufferedEdits
- applyBufferedEdits 直接改写运行时 prompt（enabled/字段/oai_settings.prompts 镜像）；commit/saveMeta 抛错后缓冲保留但运行时已污染；discard 只还原 prompt_order 不还原 prompts → 已丢弃改动经后续 saveMeta 静默落盘。
- 修法建议：commit 前快照运行时 prompts+order 失败回滚；或 discard 前按缓冲反推还原。风险：oai_settings.prompts 跨 preset 镜像回滚复杂，故略过。

### N2 [MEDIUM/REAL] create-delta 后基线推进含挂载的运行时态（本轮已修，仅记录）
- 修复：create-delta 分支 finalizeEditorSession(ctx, false) 不推进基线。

### N3 [LOW/MARGINAL] drag→unmount→undo-unmount 后内存/磁盘顺序分歧，reload 静默回退
- 位置：`profileEditorRender.ts` onReorder（即时 saveMeta）vs `profileEditorState.ts` undoMount
- R4 #D 既有设计延伸，略过。

## R8 轮归档（D8 略过项）

### N3 [LOW/MARGINAL] 重复文档注释（handlers.ts finalizeEditorSession doc 与 inline 重复）
- 上轮 #N4 结转，D7/D8 未清理。无害，略过。

### N2 [LOW/MARGINAL] create-delta 后立即 reorder 落盘（本轮已修，仅记录）
- 与 R8 #N1 同源；D8 加 restoreRuntime 还原运行时残留后闭合。

## R9 轮归档（D9 略过项）

### N2 [MEDIUM/REAL] create-delta 的 prompts 残留半环：字段/toggle 改动残留运行时，restoreRuntime 只还原 order
- 位置：`profileEditorState.ts` restoreOrderIfUncommitted（只还原 order）；`presetBuffers.ts` applyBufferedEdits（Object.assign 写 prompts + mirrorFieldsToActivePreset）
- create-delta 提交后源 profile 字段/toggle 未持久化，但运行时 prompts 字段值/enabled 已被 applyBufferedEdits 改写；restoreRuntime 只还原 order 不还原 prompts → 无缓冲无 staged，关闭无确认，后续 saveMeta 静默落盘改写值，profile 解析与运行时持久分歧。
- 与 R7 N1 同源（运行时副作用无快照回滚）。修复需提交前快照 prompts + oai_settings 镜像，风险>收益，略过。

### N4 [LOW/MARGINAL] 重复文档注释（handlers.ts finalizeEditorSession doc）结转
- R8 #N3 / R7 #N4 持续结转，无害，略过。

## R10 轮归档（D10 略过项）

### N2 [LOW/MARGINAL] create-delta 后未提交挂载改动无提示消失
- 位置：`profileEditorHandlers.ts` create-delta 分支（restoreRuntime 还原运行时）
- create 只存快照差异，源 profile 不该被会话挂载改动污染——设计取舍。建议后续加 toast 提示，略过。

### N3 [LOW/MARGINAL] commit 成功后 renderDialog 抛错路径：基线已推进但 UI 未刷新
- 低概率，无数据危害。略过。

### N4 [LOW/MARGINAL] 重复文档注释
- finalizeEditorSession doc 已完善（多行参数说明），inline 为具体实现注释，非真重复。无需处理。
