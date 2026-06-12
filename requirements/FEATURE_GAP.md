# DvalinCode vs Codex — 功能差距与开发需求清单

> 基于 OpenAI Codex CLI（v0.129–v0.133）与 DvalinCode 现状的对比分析。
> 优先级：🔴 P0（必须有）· 🟠 P1（强烈建议）· 🟡 P2（锦上添花）
>
> **2026-06-10 复核：** 已对照 v0.3.0 实际代码逐项审计，标记 ✅ 已交付 / 🟡 部分交付 / ❌ 未实现。各节「需求」列表保留为当时的规格说明。

---

## 现状速览

| 维度 | DvalinCode 现有 | Codex |
|---|---|---|
| 核心 Agent 循环 | ✅ 8 状态机 | ✅ |
| 工具集 | ✅ 8 个 (read/write/edit/delete/list/search/shell/git_status) | ✅ 更丰富 |
| Session 持久化 | ✅ JSON 文件 | ✅ JSONL |
| 多 Provider 支持 | ✅ OpenAI 兼容 | ✅ |
| Web GUI | ✅（自研） | ❌ 仅 TUI |
| Undo/Rollback | ✅ undoStack | ✅ |
| 流式输出 | ✅ SSE + token_delta | ✅ SSE |
| 沙箱隔离 | 🟡 仅 macOS sandbox-exec | ✅ seatbelt/bwrap |
| 审批流 | ✅ 三档模式 + 审批握手 | ✅ 三档模式 |
| 项目记忆 | ✅ AGENTS.md | ✅ AGENTS.md + SQLite |
| Token 统计 | ✅ 用量 + 费用估算 | ✅ |
| Git 感知 | ✅ 工具 + 提示注入 | ✅ |
| MCP 支持 | ❌ | ✅ |
| 中断/取消 | ✅ AbortController | ✅ |

---

## 🔴 P0 — 必须实现（影响基本可用性）

### P0-1｜流式输出（Streaming Response）✅

**状态（2026-06-10 复核）：✅ 已交付。**
- SSE 流式解析、`onDelta` 逐块回调、`stream_options.include_usage`、AbortSignal 透传：`src/providers/openaiCompatible.ts`（`chatStreaming`）
- WebSocket `token_delta` 事件推送：`src/server/wsHandler.ts`
- 前端逐块追加渲染：`web/src/hooks/useChat.ts`（`token_delta` 分支）

**原现状（2026-05-22）：** `AgentRunner.runTurn()` 等待 LLM 完整响应后才返回，用户无实时反馈。  
**Codex：** SSE 逐 token 推流，TUI 实时渲染，Web 端通过 WebSocket delta 事件更新。

**需求：**
- Provider 层支持 SSE 流式接口（`/chat/completions` stream=true）
- `AgentRunner` 接受 `onToken(delta: string)` 回调，逐块 emit
- WebSocket 协议新增 `token_delta` 事件类型
- 前端 `MessageBubble` 实时追加内容，光标动画

**实现建议：** 改造 `openaiCompatible.ts` 用 `ReadableStream` 解析 SSE，`runTurn` 通过 `onEvent` 回调推送 delta。

---

### P0-2｜操作审批流（Approval Policy）✅

**状态（2026-06-10 复核）：✅ 已交付。**
- 三档审批模式 `readonly` / `auto-edit` / `full-auto` + `requestApproval` 回调：`src/core/context.ts`
- `approval_request` / `approval_response` 双向握手协议（中断时自动拒绝挂起审批）：`src/server/wsHandler.ts`
- 前端审批弹窗，含 Diff 预览：`web/src/components/ApprovalDialog.tsx`

**原现状（2026-05-22）：** 仅有全局 `allowWrite`/`allowExecute` 布尔开关，写操作无 per-action 确认。  
**Codex：** 三档模式 — `suggest`（只读）/ `auto-edit`（文件变更免确认）/ `full-auto`（全自动）。

**需求：**
- 定义三档审批策略：`readonly` / `auto-edit` / `full-auto`
- `write_file`/`edit_file` 在非 full-auto 模式下，执行前发送 `approval_request` 事件到前端
- 前端弹出 Diff 预览卡片，用户点击「允许」/「拒绝」
- WebSocket 增加双向审批握手协议：
  ```
  server → client: { type: 'approval_request', id, tool, input, diff }
  client → server: { type: 'approval_response', id, approved: true/false }
  ```
- Shell 命令单独审批，显示完整命令文本

---

### P0-3｜中断 / 取消（Interrupt & Cancel）✅

**状态（2026-06-10 复核）：✅ 已交付。**
- 每个 WS 连接维护 `AbortController`，收到 `{ type: 'interrupt' }` 即 abort，新消息自动取消当前 turn：`src/server/wsHandler.ts`
- `AbortSignal` 贯穿 agent 循环与 LLM fetch：`src/agent/runner.ts`、`src/providers/openaiCompatible.ts`
- 发送中 Composer 显示停止按钮；中断后保留已生成的部分内容：`web/src/components/Composer.tsx`、`web/src/hooks/useChat.ts`（`interrupted` 分支）

**原现状（2026-05-22）：** Agent 一旦开始就无法打断，前端 sending 状态下用户只能等待。  
**Codex：** `turn/interrupt` 可随时终止，新消息自动取消当前 turn。

**需求：**
- 服务端：每个 WS 连接维护 `AbortController`，收到 `{ type: 'interrupt' }` 时 abort
- `AgentRunner.runTurn()` 接受 `signal: AbortSignal`，LLM fetch 和工具执行均遵守
- 前端：发送中时 Composer 的发送按钮变为「停止」图标，点击发送 interrupt 消息
- 中断后返回已生成的部分内容，不丢弃已执行的工具结果

---

### P0-4｜Session 完整恢复（Session Restore in UI）✅

**状态（2026-06-10 复核）：✅ 已交付。**
- `loadSession(id)` 拉取历史 session 并恢复到 UI，后续对话沿用原 session ID 追加：`web/src/hooks/useChat.ts`
- 后端消息（含 tool_calls 与 tool 结果配对）映射回前端消息类型：`web/src/hooks/useChat.ts`（`mapBackendMessages`）

**原现状（2026-05-22）：** 侧边栏可列出历史 session，但点击只会新建对话，无法恢复历史消息到 UI。  
**Codex：** `/resume` 完整恢复历史 thread，包含所有消息和工具调用记录。

**需求：**
- `GET /api/sessions/:id` 已有，前端点击 session 时加载其 `messages` 数组
- 将 `ChatMessage[]`（含 tool_call 历史）映射回前端 `ChatMessage` 类型并渲染
- `useChat` hook 新增 `loadSession(id)` 方法，接管 currentSessionId
- 恢复后继续对话时沿用原 session ID，消息追加而非覆盖

---

### P0-5｜Shell 沙箱隔离（Sandbox）🟡

**状态（2026-06-10 复核）：🟡 部分交付。**
- 已有：macOS 上 `shell` 工具经 `sandbox-exec` + seatbelt profile 运行，默认禁网络、写入仅限 workspace + /tmp + /var：`src/tools/shell.ts`
- 缺口：Linux `bwrap` 未实现；`sandboxMode` 配置项与前端沙箱模式选择未实现。后续工作已立项：`requirements/plans/04-execution-safety.md`

**原现状（2026-05-22）：** `shell` 工具直接 `spawn`，无任何隔离，可执行任意系统命令。  
**Codex：** macOS 用 `seatbelt`，Linux 用 `bwrap + landlock`，网络默认关闭。

**需求：**
- macOS：通过 `sandbox-exec` + seatbelt profile 限制写目录和网络
- Linux：通过 `bwrap` 挂载只读 `/` + 可写 workspace 目录
- `DvalinContext` 新增 `sandboxMode: 'none' | 'workspace-write' | 'readonly'`
- 前端 SettingsPanel 增加沙箱模式选择
- 工具执行时 stderr 捕获沙箱违规错误并友好提示

---

## 🟠 P1 — 强烈建议（影响日常使用体验）

### P1-1｜项目记忆 / AGENTS.md ✅

**状态（2026-06-10 复核）：✅ 已交付。**
- 读取 cwd 下的 `AGENTS.md`，注入 system prompt 的 PROJECT INSTRUCTIONS 节：`src/server/wsHandler.ts`
- 缺口（小）：仅读取 cwd 单层，未沿 git root → cwd 路径链收集；`dvalincode init` 暂不生成模板（`src/commands/init.ts`）

**原现状（2026-05-22）：** 无项目级指令加载，每次 session 从零开始。  
**Codex：** 从 git root 向下收集所有 `AGENTS.md`，注入 system prompt。

**需求：**
- `scanProject` 时额外读取 `AGENTS.md`（git root → cwd 路径链）
- 内容追加到 system prompt 的 `[Project Instructions]` 节
- `dvalincode init` 命令生成项目默认 `AGENTS.md` 模板
- 前端欢迎页面提示「检测到 AGENTS.md，已加载 X 条项目指令」

---

### P1-2｜Token 用量追踪 ✅

**状态（2026-06-10 复核）：✅ 已交付。**
- Provider 透传 `usage`，多轮迭代累加：`src/providers/openaiCompatible.ts`、`src/agent/runner.ts`
- WebSocket `done` 事件携带用量：`src/server/wsHandler.ts`
- 前端 topbar 显示本轮 token 数（hover 显示输入/输出明细）与 session 累计费用：`web/src/App.tsx`
- 缺口（小）：未实现 80k 阈值黄色警告

**原现状（2026-05-22）：** 无任何 token 计数显示。  
**Codex：** `/status` 显示 session token 用量，TUI 状态栏实时更新。

**需求：**
- OpenAI 响应的 `usage` 字段（prompt_tokens, completion_tokens）从 provider 层透传
- `LoopResult` 新增 `usage: { promptTokens, completionTokens, totalTokens }`
- WebSocket `done` 事件携带 token 用量
- 前端 topbar 显示本轮 token 数，hover 显示 session 累计
- 超过阈值（如 80k tokens）时显示黄色警告，提示执行压缩

---

### P1-3｜真正的上下文压缩（LLM-based Compaction）✅

**状态（2026-06-12 复核）：✅ 已交付。**
- 已有：`/compact` 调用 LLM 生成结构化摘要（Goal / Completed / Decisions / CurrentState / Pending），失败时回退保留最近 20 条：`src/agent/loop.ts`（`handleCompact`）
- 自动触发已接线：`processMessage` 的 `RESTORE` 态在每轮开始估算历史 token，超过 `contextTokenLimit * compactThreshold`（默认 128k × 0.7）时自动进入 `COMPACT` 态再构建本轮：`src/agent/loop.ts`。回归测试覆盖触发/不触发两条路径：`tests/agent.test.ts`

**原状态（2026-06-10）：🟡 部分交付。** 缺口：自动触发未接线 —— `compactThreshold` 已定义（`src/agent/types.ts`）但状态机从不自动进入 COMPACT 态

**原现状（2026-05-22）：** `COMPACT` 状态仅做简单切片（保留最后 40 条），注释写着 `TODO`。  
**Codex：** 调用 summary 模型生成摘要，替换历史消息，保留关键决策上下文。

**需求：**
- 实现 `compactContext(messages, provider)` — 调用 LLM 生成结构化摘要
- Prompt 模板：要求 LLM 输出「目标 / 已完成步骤 / 关键决定 / 待办事项」
- 摘要作为 `system` role 消息插回，旧消息截断
- 触发阈值可配置（默认 messages > 50 或 estimated tokens > 80k）
- `/compact` slash command 手动触发，前端 Composer 支持

---

### P1-4｜Git 感知（Git Awareness）✅

**状态（2026-06-10 复核）：✅ 已交付。**
- System prompt 自动注入当前分支与变更文件数：`src/server/wsHandler.ts`
- `git_status` 工具（分支 + 最近 5 条 commit + 变更文件，只读）与 `/git` 命令：`src/tools/gitStatus.ts`、`src/agent/loop.ts`
- 前端 topbar 显示当前分支：`web/src/App.tsx`、`src/server/routes/git.ts`
- 缺口（小）：`git_diff` 工具未实现

**原现状（2026-05-22）：** 完全不知道 git 状态。  
**Codex：** 读取 branch、最近 commit、未提交变更，支持 stage/commit。

**需求：**
- `scanProject` 扩展：检测 `.git` 目录，读取当前分支、最近 3 条 commit
- `git_status` 工具（只读）：返回已修改 / 暂存 / 未追踪文件列表
- `git_diff` 工具：返回工作区 diff 文本
- System prompt 自动注入 git 上下文
- 前端 topbar 显示当前分支名

---

### P1-5｜前端 Diff 预览（Diff Viewer in UI）✅

**状态（2026-06-10 复核）：✅ 已交付。**
- `write_file` / `edit_file` 生成结构化 diff，随 `tool_result` 的 metadata 下发：`src/core/diffPreview.ts`、`src/tools/writeFile.ts`、`src/tools/editFile.ts`
- 前端 DiffViewer 渲染（增删行着色），审批弹窗复用同一组件：`web/src/components/DiffViewer.tsx`、`web/src/components/AgentActivity.tsx`、`web/src/components/ApprovalDialog.tsx`

**原现状（2026-05-22）：** 工具调用结果在 AgentActivity 中显示原始文本，`write_file`/`edit_file` 无高亮 diff。  
**Codex：** 内置 diff_model 模块，文件变更以 unified diff + 语法高亮展示。

**需求：**
- 后端 `tool_result` 事件新增 `diff?: string` 字段（unified diff 格式）
- 前端 `AgentActivity` 检测到 diff 字段时渲染 `DiffViewer` 组件
- 新增 / 删除行分别用绿色 / 红色背景 + `+`/`-` 前缀
- 行号显示，长文件支持折叠

---

### P1-6｜@ 文件引用（File Mention）✅

**状态（2026-06-10 复核）：✅ 已交付。**
- Composer 监听 `@` 弹出文件搜索浮层，支持键盘导航与多文件引用：`web/src/components/Composer.tsx`
- 后端解析 `@path` 并将文件内容注入 user 消息（限制在 cwd 内）：`src/server/wsHandler.ts`（`expandAtMentions`）

**原现状（2026-05-22）：** 用户只能用自然语言描述文件路径，无法精确引用。  
**Codex：** TUI 和 API 都支持 `@filename` 语法，自动展开文件内容注入 context。

**需求：**
- Composer 输入框监听 `@` 字符，弹出文件搜索浮层（调用 `list_files`）
- 选中文件后在消息中替换为 `@path/to/file`
- 消息发送前，后端解析 `@` 引用，将文件内容作为附件注入 user 消息
- 支持多文件引用

---

### P1-7｜多审批模式 UI（Approval Mode Switcher）✅

**状态（2026-06-10 复核）：✅ 已交付（形态不同）。**
- 以 Chat / Cowork / Code 三模式切换器落地，分别映射 `readonly` / `auto-edit` / `full-auto`：`web/src/components/ModeSwitcher.tsx`（经 Sidebar 渲染）、`src/server/wsHandler.ts`（`MODE_APPROVAL`）
- 备注：独立的 `web/src/components/ApprovalModeSwitch.tsx` 组件存在但当前未被引用

配合 P0-2，前端需要直观切换审批模式：

**需求：**
- 顶栏新增审批模式 SegmentedControl：`只读` / `自动编辑` / `全自动`
- 对应后端 `allowWrite`/`allowExecute` 的三段组合
- 模式切换时弹出风险提示（全自动模式需二次确认）
- 当前模式以色标显示：绿（只读）/ 黄（自动编辑）/ 橙（全自动）

---

## 🟡 P2 — 锦上添花（差异化竞争力）

### P2-1｜MCP 支持（Model Context Protocol）❌

**状态（2026-06-10 复核）：❌ 未实现。** 实施方案已立项：`requirements/plans/03-mcp-support.md`。

接入 MCP 生态，让用户自定义工具集（如 Slack、Linear、数据库查询）。

**需求：**
- `config.json` 新增 `mcp_servers` 配置数组（name, command/url, transport）
- 启动时连接 MCP server，将其工具注册到 `ToolRegistry`
- LLM Config 页面增加「MCP Servers」管理面板
- 工具调用结果统一走现有 `tool_result` 事件

---

### P2-2｜内置 Web 搜索工具 ❌

**状态（2026-06-10 复核）：❌ 未实现。**

**需求：**
- 新增 `web_search` 工具（access: read）
- 接入 Tavily / Serper / DuckDuckGo API，配置在 LLM Config
- 返回摘要 + 来源链接，前端 AgentActivity 显示搜索结果卡片

---

### P2-3｜生命周期 Hooks ❌

**状态（2026-06-10 复核）：❌ 未实现。**

**需求：**
- `config.json` 支持 `hooks.preToolUse` / `hooks.postToolUse` 脚本配置
- 工具执行前后 spawn hook 脚本，传递工具名和输入/输出
- 典型用途：代码格式化（prettier after write_file）、通知（任务完成后 terminal-notifier）

---

### P2-4｜多 Profile 配置 🟡

**状态（2026-06-10 复核）：🟡 部分交付。**
- 已有：`config.json` 支持命名 `profiles`，LLM Config 页面可保存 / 应用 / 删除 Profile：`src/server/configStore.ts`、`src/server/routes/config.ts`、`web/src/components/LLMConfigModal.tsx`
- 缺口：CLI `--profile <name>` 参数未实现

**需求：**
- `config.json` 支持 `profiles` 命名配置（不同项目不同 provider/model/permissions）
- LLM Config 页面顶部增加 Profile 选择器
- CLI 支持 `--profile <name>` 参数

---

### P2-5｜计划模式（Plan Mode）✅

**状态（2026-06-10 复核）：✅ 已交付。**
- `/plan` 指令进入「只提方案不执行」模式：`src/agent/loop.ts`
- 前端以 PlanCard 展示步骤列表并支持继续执行：`web/src/components/PlanCard.tsx`、`web/src/components/MessageBubble.tsx`

**需求：**
- Composer 支持 `/plan` 指令，进入「只提方案不执行」模式
- Agent 生成步骤列表（checkbox 格式），用户勾选后再执行
- 前端专属 PlanView 组件展示待执行步骤

---

### P2-6｜Token 费用估算 ✅

**状态（2026-06-10 复核）：✅ 已交付（形态不同）。**
- 内置各 provider/model 单价表 + 费用计算（含模型名部分匹配回退），topbar 显示 session 累计费用：`web/src/lib/pricing.ts`、`web/src/App.tsx`
- 备注：单价为内置硬编码表，未做成 LLM Config 可配置项（`price_per_1k_tokens`）

**需求：**
- 基于 provider 的 token 单价配置，实时计算本 session 费用
- 显示格式：`本轮 $0.0023 · 累计 $0.041`
- LLM Config 新增 price_per_1k_tokens 配置项

---

## 优先级路线图

> 2026-06-10 更新：原 Q1–Q3 计划项已基本全部交付（v0.3.0），路线图改为按实际状态划分。

```
✅ 已交付（截至 v0.3.0）
├── P0-1 流式输出 · P0-2 审批流 · P0-3 中断/取消 · P0-4 Session 恢复
├── P1-1 AGENTS.md · P1-2 Token 统计 · P1-4 Git 感知 · P1-5 Diff 预览
├── P1-6 @ 文件引用 · P1-7 审批模式 UI（模式切换器形态）
├── P1-3 上下文压缩（/compact + compactThreshold 自动触发）
└── P2-5 计划模式 · P2-6 费用估算

🟡 部分交付（待收尾）
├── P0-5 沙箱：已有 macOS sandbox-exec，缺 Linux bwrap + sandboxMode 配置
└── P2-4 Profile：后端 + GUI 已支持，缺 CLI --profile 参数

⏭ 下一阶段（详见 requirements/plans/）
├── 子代理与后台任务（plans/02-subagent-tasks.md）
├── P2-1 MCP 支持（plans/03-mcp-support.md）
└── P0-5 收尾 + 执行安全加固（plans/04-execution-safety.md）

未排期
├── P2-2 内置 Web 搜索
└── P2-3 生命周期 Hooks
```

---

## DvalinCode 的差异化优势（不必追赶 Codex 的点）

| 功能 | 说明 |
|---|---|
| **Web GUI** | Codex 仅有 TUI，DvalinCode 的浏览器界面是独特优势 |
| **Provider 中立** | Codex 深度绑定 OpenAI，DvalinCode 支持任意 OpenAI 兼容端点（DeepSeek / Ollama / Groq 等） |
| **零依赖运行时** | Codex 需要 Node 环境，DvalinCode 目标是轻量可嵌入 |
| **开放 REST API** | 后端暴露完整 API，可被其他工具集成 |

---

*生成日期：2026-05-22 | 参考版本：Codex v0.133.x | 状态复核：2026-06-10，对照 DvalinCode v0.3.0 代码*
