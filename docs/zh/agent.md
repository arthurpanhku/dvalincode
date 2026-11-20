# 内置 Agent

[English](../agent.md) · **中文**

DvalinCode 自带一个编码 Agent：交互式终端 Agent（`dvalincode`）、Web GUI
（`dvalincode serve`）和[桌面应用](gui.md)。在 Dvalin 的验证流程里，它只是可选的修复方
之一：Codex、Claude Code 或者人都可以写修复；和所有修复方一样，它从不判定修复是否有效。
本页介绍 [CLI](cli.md) 和桌面应用共享的内容：模式、工具、Provider、架构和常见问题。

## 模式与能力

<table>
<tr><td><b>🏠 Home</b></td><td>统一容纳只读 <b>Ask</b> 与逐操作审批的 <b>Collaborate</b>，切换意图时不离开当前项目和对话。</td></tr>
<tr><td><b>⚡ Code</b></td><td>专注自主编码，支持 Ask / Plan / Auto / Bypass 权限级别；旧 Security 与 Routines 已从 Code 移除。</td></tr>
<tr><td><b>🛡️ Dvalin</b></td><td>专用白盒安全工程工作区：编排内置扫描器、Semgrep CE、Trivy、OSV-Scanner，分诊并修复发现项，运行测试和复扫，最后显式发布可审查的 Draft PR。<a href="../DVALIN.md">Dvalin 指南 →</a></td></tr>
<tr><td><b>🛡️ 安全修复闭环</b></td><td>运行本地安全扫描，或导入 CodeQL、GitHub Code Scanning、Semgrep 及兼容扫描器的 SARIF；随后创建隔离 remediation worktree，把发现项转成带源码上下文和 PR 就绪报告的聚焦修复任务。<a href="../SECURE-REMEDIATION.md">流程 →</a></td></tr>
<tr><td><b>📚 Skills</b></td><td>上传、下载和查看本地 skill bundle。DvalinCode 内置三个安全 skills —— dvalin-security-engineer（扫描、修复、复验，并为 Draft PR 写摘要）、secure-code-scan 与 secure-code-remediation —— 并提供列出 skill、读取 skill 说明、扫描、列出 case、准备 remediation worktree 的 agent tools。其他 Agent 可以加载可移植的<a href="../../integrations/claude-code/README.md#skill">安全门禁 Skill</a>。<a href="../SKILLS.md">格式 →</a></td></tr>
<tr><td><b>🖥️ 一流的 GUI</b></td><td>现代化 Web UI，包含代码语法高亮、<code>@</code> 文件引用、<code>/</code> 斜杠命令、Git 分支显示、实时 Token 与费用统计、多 LLM Profile，以及暗色 / 浅色 / 跟随系统的主题切换。</td></tr>
<tr><td><b>🖥️ 终端或 Web，同一个二进制</b></td><td>直接运行进入交互式<b>终端代理</b>，支持流式输出、行内审批和红绿 diff；或 <code>dvalincode serve</code> 启动 <b>Web GUI</b> 供浏览器/远程使用。两个前端共用同一套 agent 内核。</td></tr>
<tr><td><b>🖥️ 原生桌面应用</b></td><td><code>DvalinCode.app</code> —— 真正的 Dock 应用（系统原生 webview，非 Electron），驱动同一套引擎。macOS 上给一行安装命令加 <code>--gui</code> 即可装进 <code>/Applications</code>，从启动台直接打开。Windows 上有按用户安装的安装包，带开始菜单项和卸载项 —— 不需要管理员权限，不弹 UAC，也不用浏览器标签页。</td></tr>
<tr><td><b>🪶 零依赖二进制</b></td><td>每平台单文件可执行程序 ~25MB。无需 Node、Python、Docker。</td></tr>
<tr><td><b>🔐 本地优先</b></td><td>Session、配置、Profile、审计日志均保存在 <code>~/.dvalincode/</code>。<code>.dvalincodeignore</code> 阻止 Agent 访问敏感文件。仓库根目录的 <code>AGENTS.md</code> 作为项目级持久指令自动加载。</td></tr>
<tr><td><b>💾 可导出、可迁移</b></td><td>把<b>所有</b>本地数据（记忆、Session、配置、审计）导出为一个文件，在另一台机器导入 —— 整套环境随身带走。任意对话都能下载为干净的 <b>Markdown</b> 记录。</td></tr>
</table>

## 功能列表

| 类别 | 功能 | 说明 |
|---|---|---|
| **模式** | Home / Code / Dvalin | Home 包含只读 Ask 与审批式 Collaborate；Code 专注开发；Dvalin 是扫描到修复的安全工作区 |
| **Code 权限** | Ask Permissions / Plan Mode / Auto Mode / Bypass permissions | 已验证行为：Ask 在写入/命令前请求批准，Plan 只读且不写文件，Auto 自动执行操作，Bypass 不再弹出确认 |
| **工作区** | 打开文件夹 / 导入 Git / 添加 worktree | Home、Code 与 Dvalin 可使用本地文件夹、Git 项目和隔离 remediation worktree |
| **治理** | OpenSSF Scorecard / ISO 42001 AIMS 对齐 | Scorecard、CodeQL、Dependabot、固定 SHA 的 Actions、AI 影响评估、风险登记和审查节奏记录在 `docs/security/` 与 `docs/governance/` |
| **安全修复** | 内置 + Semgrep CE + Trivy + OSV-Scanner / SARIF / 测试 / Draft PR | Dvalin 检测已安装引擎、统一 SARIF、风险评分、驱动证据化修复、验证变更，并只在用户显式操作后发布 Draft PR |
| **Agent 集成** | `dvalin agents` / MCP server | 找出这台机器上的 Claude Code、Codex、Cursor、VS Code、Gemini CLI 和 OpenCode，把 Dvalin 的 MCP server 接进每一个，加 `--yes` 才写入；也可以交给 CC Switch 同步。[编辑器与 MCP →](../../integrations/mcp/) |
| **Skills** | 上传 / 下载 / 内置安全 skills | Skills 保存在 `~/.dvalincode/skills`；内置 skills 用专门的 agent tools 引导安全扫描与修复。[格式 →](../SKILLS.md) |
| **输入框** | `@` 文件引用 | 输入 `@` 触发模糊文件搜索，选中文件自动插入到 prompt |
| | `/` 斜杠命令 | `/clear` `/compact` `/git` `/plan` `/undo` `/help` |
| | 多行输入 + 中断 | <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行，Stop 按钮中断生成 |
| **工具 UI** | 行内 diff | `edit_file` 与 `write_file` 结果以红绿统一 diff 呈现，默认折叠 |
| | 审批对话框含 diff | Home → Collaborate 下，文件变更在执行前显示 diff |
| | 实时工具计数 + Token + 费用 | 顶栏实时显示当前 session 累计数据 |
| **Agent** | LLM 上下文压缩 | `/compact` 将历史压缩为 目标/已完成/决策/待办 结构化摘要 |
| | 持久化 Undo 栈 | `/undo [N]` 撤销最近 N 个工具调用 |
| | Run Report | 每次运行的 Markdown 摘要（文件、命令、决策、测试结果）—— GUI 卡片 + `dvalincode report` |
| | Git 感知 | 顶栏显示分支名；Git 上下文自动注入 prompt；只读的 `git_status`、`git_diff`、`git_log`、`git_show`、`git_blame` 工具，在 Ask 和 Plan 中同样可用 |
| | 代码搜索与编辑 | `search_text` 支持正则表达式、显示上下文行，并跳过 `.gitignore` 忽略的路径；`edit_file` 一次调用即可完成多处编辑或全部替换；`read_file` 可按行范围读取超过 256 KB 的文件 |
| | 任务清单 | `update_plan` 维护一份步骤清单，桌面应用以卡片形式展示；在 Code 模式下，若 Agent 在仍有未完成步骤时停下，会被要求继续 |
| | `AGENTS.md` 项目记忆 | 每个仓库的持久指令，每轮对话自动加载 |
| | 联网搜索 + 网页读取 | `web_search` 默认免费：它调用 Exa 的免费额度，不需要密钥，搜索词会发给 Exa。这一步失败时（例如触发 Exa 的免费频率限制），会自动转用 Tavily、Brave Search 或 Exa 的 API 密钥，顺序是先用 设置 → LLM Providers → Web search 里保存的密钥，再依次用 `TAVILY_API_KEY`、`BRAVE_API_KEY`、`EXA_API_KEY`。如果配置了自己的 SearXNG（`DVALINCODE_SEARXNG_URL`），就用它代替 Exa。可以在设置里关掉免费这一步，也可以在 `~/.dvalincode/config.json` 里写 `"freeWebSearch": false`，CLI 读的是同一个文件。`web_fetch` 无需密钥，把公开网页读取为文本，每轮首次访问某个站点时请求批准。两者都遵守策略的 `network` 级别，审计只记录来源（origin） |
| **安全** | 防篡改审计日志 | 每次运行在 `~/.dvalincode/audit/` 生成哈希链 JSONL；`dvalincode report verify` 可检测修改 |
| | macOS Shell 沙箱 | `sandbox-exec` 拒绝网络；写入仅限 cwd 与 `/tmp` |
| | `.dvalincodeignore` | 类 gitignore 排除；阻止 `read_file` / `list_files` / `search_text` |
| | 逐操作审批 | Home → Collaborate 下每次写入/删除/shell 都需用户批准 |
| **外观** | 主题切换 | 暗色 / 浅色 / 跟随系统，持久保存；`跟随系统` 实时跟随 OS |
| **Providers** | OpenAI 兼容端点 | 见下方 [Provider](#provider) |
| | 多 Profile 配置 | 保存并切换多组 (provider, model, API key) 命名配置 |
| **Session** | 自动保存与恢复 | 所有 session 以 JSON 持久化到 `~/.dvalincode/sessions/` |
| | LLM 摘要记忆 | 跨 session 摘要在重启后保持 Agent 上下文 |
| **记忆** | 本地用户/项目记忆 | 可搜索的事实、偏好、决策，存于 `~/.dvalincode/memory/`；支持从 Claude/Hermes/Markdown 导入 |
| **数据可迁移** | 导出 / 导入全部数据 | 记忆 + Session + 配置 + 审计打包成一个文件 —— `dvalincode export` / `import`，或 GUI 设置 → Export / Import |
| | Markdown 记录 | 任意对话下载为 Markdown —— 侧栏下载图标、`dvalincode session md <id>`，或 `/api/sessions/:id/markdown` |

## 斜杠命令

| 命令 | 说明 |
|---|---|
| `/clear` | 清空当前对话（客户端，开启新 session） |
| `/compact` | 调用 LLM 生成结构化摘要压缩上下文 |
| `/undo [N]` | 撤销最近 N 个工具调用（默认 1） |
| `/git` | 执行 `git_status`，显示分支、最近提交、变更文件 |
| `/plan <task>` | 让 Agent 逐步规划任务而**不**执行 |
| `/help` | 显示所有可用命令 |

> 审计日志通过 `dvalincode report` **命令行**查看（`--last` / `<run-id>` / `verify`），不是斜杠命令。

## Provider

Agent 支持任意 OpenAI 兼容端点（包括本地模型），并通过原生适配器支持 Anthropic。

- 终端首次运行的设置向导提供 DeepSeek、OpenAI、Anthropic、Groq、OpenRouter 和 Ollama。
- GUI 的 **LLM Configuration** 另外列出 Google、经 OpenRouter 的 Claude、xAI、Mistral、
  Together、Fireworks、Perplexity、Qwen、Moonshot 和智谱（Zhipu），以及可填任意 OpenAI
  兼容 base URL 的 **Custom**。
- **Ollama** 在你自己的机器上运行：无需 API Key、无需联网、没有 Token 费用。若修复这一步
  也必须完全本地、开放，可以在这里选开放权重模型；托管模型的许可取决于相应 provider。
- **CC Switch**：`provider set cc-switch` 让请求经 CC Switch 的本地路由（`127.0.0.1:15721`）
  转给它的 Codex 当前使用的服务商；key 由 CC Switch 保管。

在 **LLM Configuration** 里保存命名 Profile 并随时切换；顶栏实时显示本 session 的费用。

## 架构

```
┌───────────────────────────┐   ┌─────────────────────────┐
│  终端 UI (readline)        │   │  浏览器 GUI (React/Vite) │
│  流式输出 · 行内审批       │   │  ChatThread · DiffViewer │
└─────────────┬─────────────┘   └────────────┬────────────┘
              │ 进程内调用          HTTP / WebSocket
              │                ┌───────────────▼─────────────┐
              │                │  Express + ws 服务            │
              │                │  /api/* · `dvalincode serve` │
              │                └───────────────┬─────────────┘
              └──────────────┬─────────────────┘
┌────────────────────────────▼────────────────────────────┐
│  runAgentTurn —— 共享回合执行器 (src/agent/session)       │
│  provider · prompt（mode · git · AGENTS.md）· session     │
└────────────────────────────┬────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────┐
│                  Agent 引擎                              │
│  AgentLoop（8 状态机） → AgentRunner                     │
│  流式输出 · 中断 · Undo 栈 · LLM 压缩                    │
│  run_start / run_end → AuditSink（哈希链 JSONL）         │
└──────────────────────────┬──────────────────────────────┘
                           │ run()
┌──────────────────────────▼──────────────────────────────┐
│  ToolRegistry — Zod schema + 权限控制                    │
│  + 审计埋点：tool_call · file_* · shell_exec            │
│  read_file · list_files · search_text · git_status ·    │
│  write_file · edit_file · delete_file · shell           │
│  web_search · web_fetch                                 │
│  git_log · git_show · git_blame · update_plan           │
└─────────────────────────────────────────────────────────┘
```

### Agent Loop —— 8 状态

```
RESTORE → COMPACT → COMMAND → BUILD → RUN → SAVE → RESPOND → DONE
```

1. **RESTORE** —— 从 `~/.dvalincode/sessions/` 加载 session
2. **COMPACT** —— 上下文接近上限时压缩历史（LLM 摘要）
3. **COMMAND** —— 处理内置斜杠命令
4. **BUILD** —— 组装系统 prompt（模式 prompt + 项目 + git + AGENTS.md）
5. **RUN** —— 交给 `AgentRunner` 执行 LLM 工具调用循环
6. **SAVE** —— 持久化 session
7. **RESPOND** —— 生成跨 session 摘要记忆
8. **DONE**

## 常见问题

<details>
<summary><b>会把我的代码发送到第三方吗？</b></summary>
<br>
只发送 Agent 向你配置的 LLM 发送的内容。Session、配置、Profile 全部保存在本地 <code>~/.dvalincode/</code>。如需排除敏感文件，在仓库根目录放置 <code>.dvalincodeignore</code>（语法同 gitignore）。
</details>

<details>
<summary><b>没 API Key 能用吗？</b></summary>
<br>
能 —— 用 Ollama。本地拉模型（<code>ollama pull qwen2.5-coder</code>），在 LLM Configuration 中选择 <b>Ollama</b> Provider。无需 Key、无需网络、无 Token 费用。
</details>

<details>
<summary><b>为什么三种模式？只用一种不行吗？</b></summary>
<br>
它们面向不同结果和安全默认值：<b>Home</b> 统一只读 Ask 与审批式 Collaborate；<b>Code</b> 专注软件开发；<b>Dvalin</b> 用扫描证据、修复 case、隔离 worktree、测试复扫与显式 Draft PR 完成安全加固。任何时候都可切换并保留项目上下文。
</details>

<details>
<summary><b>Shell 工具有沙箱吗？</b></summary>
<br>
macOS 使用 <code>sandbox-exec</code>；Linux 在限制性网络策略下会在已安装 Bubblewrap 时启用它。Windows 暂无受支持的子进程网络沙箱，因此限制性策略会安全关闭执行，不会静默降级为无限制运行。原生命令运行器本身支持这三个平台。
</details>

<details>
<summary><b>支持哪些操作系统终端？</b></summary>
<br>
Linux 与 macOS 命令通过 <code>/bin/sh</code> 执行；Windows 命令通过系统 <code>ComSpec</code>（默认为 <code>cmd.exe</code>）执行。完整原生命令行支持管道、重定向与条件操作符；拆分的 <code>command</code> + <code>args</code> 形式会按宿主 shell 规则引用可执行文件路径及参数。
</details>

<details>
<summary><b>怎么查看 Agent 到底做了什么 —— 日志可信吗？</b></summary>
<br>
每次运行都向 <code>~/.dvalincode/audit/run-&lt;timestamp&gt;-&lt;id&gt;.jsonl</code> 写入 JSONL 审计日志。用 <code>dvalincode report --last</code> 渲染（或在 GUI 看可折叠的 Run Report 卡片）。每条记录都用 SHA-256 哈希与上一条相连，因此任何事后修改都可被检测 —— <code>dvalincode report verify &lt;run-id&gt;</code> 会报告 <code>✓ chain intact</code> 或断裂的确切位置。它是防篡改<b>可检测</b>，而非<b>不可篡改</b>：能重写整个文件的本地攻击者可重算整条链。其价值在于取证与可问责。完整威胁模型见 <a href="../AUDIT-TRAIL.md">AUDIT-TRAIL.md</a>。
</details>

<details>
<summary><b>会不会不经询问就覆盖我的文件？</b></summary>
<br>
取决于模式。<b>Home → Ask</b> 永不写入；<b>Home → Collaborate</b> 每个文件都需逐一批准（批准前可见红绿 diff）；<b>Code</b> 与 <b>Dvalin</b> 遵循所选权限级别，Auto 只应在受信任工作区或隔离分支中使用。
</details>

<details>
<summary><b>macOS 二进制无法打开 —— "未验证的开发者"</b></summary>
<br>
二进制未签名。执行一次清除隔离标记：
<pre><code>xattr -dr com.apple.quarantine ~/.dvalincode</code></pre>
或在 Finder 中右键 → 打开 → 确认。
</details>

<details>
<summary><b>Dvalin 必须安装所有外部扫描器吗？</b></summary>
<br>
不需要。Dvalin 的内置扫描器始终可用；若 <code>PATH</code> 中检测到 Semgrep CE、Trivy 或 OSV-Scanner，工作区会自动加入相应引擎。也可以导入任意兼容的 SARIF 2.1 结果。
</details>

<details>
<summary><b><code>AGENTS.md</code> 每轮都会发送吗？</b></summary>
<br>
是的 —— DvalinCode 每轮对话前读取项目根目录的 <code>AGENTS.md</code>，注入系统 prompt 的 <code>=== PROJECT INSTRUCTIONS ===</code> 段。保持精简 —— 它会占用 token 预算。
</details>
