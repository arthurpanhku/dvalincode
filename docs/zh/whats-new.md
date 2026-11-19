# 新功能

[English](../whats-new.md) · **中文**

每个版本的亮点，按从新到旧排列。每个版本的全部改动见 [Releases 页面](https://github.com/arthurpanhku/dvalincode/releases)。

## ⭐ v0.27.0 新功能 —— 两个产品：CLI 和桌面应用

DvalinCode 现在以两个产品发布，底下是同一个引擎；两者各自发布、各自安装、各有文档。

- **安装脚本一次只装一个产品** —— `curl … install.sh | bash` 只装 CLI。在 macOS 上，
  `curl … install.sh | bash -s -- --gui` 只装 `DvalinCode.app`，不改 `PATH`。装 CLI 时
  不再顺带装桌面应用，`DVALINCODE_NO_APP` 也随之移除。
- **桌面应用有了 Windows 安装包** ——
  `dvalincode-gui-v*-windows-x64-setup.exe` 按用户安装到 `%LocalAppData%\Programs\DvalinCode`，
  不需要管理员权限、不弹 UAC，会创建开始菜单项和卸载项；缺少 Microsoft Edge WebView2 Runtime
  时会一并安装。`.exe` 现在带图标和版本信息，也不会在应用窗口旁边多开一个控制台窗口。
- **每个桌面版发布前都先在 Windows 上试一遍** —— 发布流程会先安装应用、启动它，确认窗口加载出
  界面并登录到内嵌服务，再关掉、卸载，全部通过才会发布。
- **桌面应用只支持 macOS 和 Windows** —— 从没真正运行过的 Linux 桌面构建已移除。Linux 上请使用
  CLI，网页界面用 `dvalincode serve`。
- **CLI 压缩包只包含 CLI** —— 去掉了 `start.sh` 和 `start.bat`；网页 GUI 用 `dvalincode serve` 启动。
- **每个产品一份指南** —— README 改成入口页，另有 [CLI 指南](cli.md)和[桌面应用指南](gui.md)，
  中英文各一份。

---

## ⭐ v0.24.0 新功能 —— 能上网、更多受治理的工具、更精简的 GUI

- **GUI 服务端需要访问令牌** —— `dvalincode serve` 现在会拒绝不带令牌的 `/api` 和
  `/ws` 请求，令牌在每次启动时生成；桌面应用的内嵌服务端从下一个版本起也一样。
  打印出的启动链接带着令牌，页面会把它换成 HttpOnly cookie；脚本用
  `Authorization: Bearer`。设置 `DVALINCODE_SERVER_TOKEN` 可在重启后沿用同一个令牌。
  不带令牌的链接会打开解锁页。
- **更精简的 GUI** —— Web GUI（以及下一个版本的桌面应用）所有工作区共用一个侧栏：
  New chat（⌘N）、Chat / Code / Dvalin 切换（Home 改名为 Chat）、按项目分组的最近
  会话，以及底部的 Settings。Ask 和 Collaborate 移进了输入框的模式菜单。不起作用的
  控件，比如"强度"选择和侧栏提示词模板，已经去掉。输入法还在选字时按回车不再误发送，
  电脑睡眠唤醒后连接会自动恢复，浅色主题下代码也清晰可读。
- **Agent 可以搜索和阅读网页** —— `web_search` 使用 Tavily、Brave Search 或你自己的
  SearXNG；`web_fetch` 把公开网页读成文本，每轮首次访问某个站点时请求批准，并拒绝
  私有、回环和元数据地址。两者都遵守策略的 `network` 级别，审计只记录来源。
- **更多受治理的工具** —— 只读 Git 历史（`git_log`、`git_show`、`git_blame`）、正则
  搜索、按范围读取、批量 `edit_file`、多文件 `apply_patch`、`update_plan` 任务清单、
  结构化的 `ask_user` 提问，以及 GUI 里的图片附件。它们和其他工具一样，经过同一套
  策略与审批检查。
- **密钥不进模型** —— 工具输出发给模型前会过滤可识别的凭据格式；`write_file`、
  `edit_file` 和 `apply_patch` 拒绝把脱敏占位符写回去覆盖真实密钥。
- **预算与回滚** —— 策略可以用 `maxCostUsd` 限制模型花费。`dvalincode run --checkpoint`
  会给覆盖范围内的文件做快照，无头运行无论成功还是失败，都能用
  `dvalincode rollback <run-id>` 恢复。
- **更严格的无头运行** —— 整个运行使用同一份策略快照；无人值守的运行若无法应用已配置
  的策略会直接拒绝；恢复的会话只能回到原来的工作区。`stream-json` 的使用方请改读
  `tool_call.inputSummary`，不再是 `tool_call.input`。
- **发布清单** —— 每个版本现在都附带 CLI 和 Web bundle 的 CycloneDX SBOM。

---

## ⭐ v0.23.0 新功能 —— 把 Dvalin 接进你已经在用的 agent

- **`dvalin agents` 找出本机的 coding agent** —— Claude Code、Codex、Cursor、
  VS Code、Gemini CLI 和 OpenCode，以及 Dvalin 已经接在了哪里。它只看不动：看
  `PATH` 上的命令、agent 创建的目录或 macOS 应用，不运行也不写入任何东西。
- **`dvalin agents connect` 一键接入** —— 为还没有 Dvalin 的 agent 列出 MCP 接入
  计划，加 `--yes` 才写入，写入逻辑和 `mcp-install` 相同。`mcp-install` 现在也支持
  Codex（通过 `codex mcp add`）、Gemini CLI 和 OpenCode。[编辑器与 MCP →](../../integrations/mcp/)
- **支持 CC Switch** —— `dvalin agents connect cc-switch` 通过 CC Switch 自己的导入
  链接把 Dvalin 交给它，再由它同步进所管理的每个 agent。`provider set cc-switch`
  现在指向 CC Switch 的本地路由 `127.0.0.1:15721`；原来的 3456 其实是
  claude-code-router 的端口。
- **导入 Codex Security 扫描结果** —— `dvalin import` 读取密封的 Codex Security
  扫描目录（校验 manifest、哈希和覆盖范围）或 SARIF 交接文件，转成 remediation
  case；同时提供可移植的 Codex 安全 skill 和仓库内插件 marketplace。
  [Codex Security 互操作 →](../../integrations/codex-security/)
- **MCP 客户端一连上就知道流程** —— server 在初始化时告诉 agent：先扫描未提交的
  改动，把零发现当作干净之前先确认覆盖范围，再查看单条发现并请求独立验证。
- **失败的回合不再丢工作** —— 中途失败的回合会保存已完成的部分，会话可以接着
  继续；审计日志也会记录它的迭代次数和 token。

---

## ⭐ v0.14.0 新功能 —— Dvalin 安全工程

- **Home 合并 Chat 与 Cowork** —— Home 统一提供只读 Ask 与审批式 Collaborate，
  保持同一个项目和对话上下文。
- **Code 回归专注开发** —— 旧 Security 与 Routines 面板已移除，侧栏只服务项目与
  自主实现工作流。
- **Dvalin 成为一等工作区** —— 编排内置扫描器、Semgrep CE、Trivy、OSV-Scanner；
  导入 SARIF；评分并分诊发现项；持久化 remediation case；创建隔离修复 worktree。
- **从证据到 Draft PR 的闭环** —— 选中的发现项可启动带源码证据的 Agent 修复，
  运行测试、类型检查、构建与复扫，审查 diff 后再显式发布 Draft PR，永不自动合并。
- **Agent loop 更早收敛、成本更低** —— 编辑前调查、停滞检测、统一工具输出上限、
  append-only prompt 缓存，以及 provider cache hit/miss 统计均已落地。

---

## ⭐ v0.12.4 新功能 —— 做完再停

- **过程性的叙述不再结束任务** —— 像「让我检查一下这个文件」这样的回复会被识别为还没做完
  的工作，Agent 会立刻接着执行它承诺的动作，而不是把它当成最终回答。
- **被截断的回复会自动恢复** —— 保留 Provider 的 finish reason，因 token 上限被截断的输出
  会触发下一次模型调用。
- **正常的编码回合有空间做完** —— 每回合的动作上限从日常的 15 次停止点，改为 100 次的紧急
  保护；更严格的组织策略限制仍然优先。
- **完成要明确** —— Code 模式被要求只在请求的工作和针对性验证都完成之后，才返回不带工具
  调用的回答。

---

## ⭐ v0.12.3 新功能 —— 长时间 Code 模式更可靠

- **长编程任务持续执行** —— Code 模式现在会在工具循环执行过程中动态压缩上下文，
  Token 估算覆盖完整 provider 请求，并将默认迭代检查点从 10 提升到 40。
- **中断后可以续接** —— 回合被中断或连接关闭时，会保存已经完成的工具状态；后续发送
  `continue` 即可从工作区的真实进度继续。
- **Agent 活动清晰而安静** —— 运行中的 session 会在侧栏显示 loading 状态；每次回复
  显示工作耗时，点击即可查看 Action 时间线，原始 Tool Call 默认保持折叠。
- **Code 模式支持 GitHub 工作流** —— 具备网络感知的 `git` 与 GitHub CLI（`gh`）
  操作现在可通过受控 shell 审批路径执行 pull、push、创建 PR，以及 Actions / 仓库命令。
- **更安全的发布流程** —— package 与 CLI 版本保持同步，`prepublishOnly` 会在发布前运行
  构建、类型检查和完整测试。
- **简单需求保持简单** —— Action 预算现在对整轮生效，不再每次模型迭代重置；Code 模式
  会优先选择最短直接路径，并在针对性验证通过后停止。

---

## ⭐ v0.12.2 新功能 —— 🖥️ 桌面应用里程碑：开箱即用

- **🖥️ 原生桌面应用在 macOS 上开箱即用** —— `DvalinCode.app` 现在能真正打开
  一个原生 Dock 窗口（WKWebView，非 Electron），驱动内嵌引擎。修复了此前所有
  桌面构建都存在的两个线程问题：阻塞式 webview 循环不再饿死内嵌服务器（空白
  窗口），webview 按 macOS 要求跑在主线程（否则窗口根本不出现）—— 服务器改由
  同一二进制的子进程承载。
- **📦 一行安装命令即装桌面应用** —— macOS 上 `curl … install.sh | bash`
  现在会把带 DvalinCode 图标的 `DvalinCode.app` 装进 `/Applications`，
  CLI 装完即可从启动台直接打开桌面窗口。`DVALINCODE_NO_APP=1` 可跳过，
  `DVALINCODE_GUI_VERSION` 可固定版本。
- **✅ macOS 桌面版不再是"实验性"** —— 窗口与内嵌服务器均已验证可用；
  Windows 与 Linux 桌面构建为交叉编译，仍属预览。

<details>
<summary>v0.9.0 —— 🛡️ 安全修复闭环 · Skills · CodeQL 加固</summary>

- **🛡️ 安全修复闭环** —— 支持运行内置本地扫描，或导入 CodeQL、GitHub
  Code Scanning、Semgrep 及兼容扫描器的 SARIF；发现项会转成本地修复 case，
  并带有源码上下文、验证说明和隔离 worktree 修复任务。
- **📚 Skills** —— 支持上传、下载、查看和复用本地 skill bundle。DvalinCode
  内置 secure-code-scan 与 secure-code-remediation skills，并提供 agent tools
  用于列出 skill、读取说明、扫描、列出修复 case、准备修复 worktree。
- **🔐 CodeQL 路径加固** —— workspace、remediation、skill 相关的用户可控路径
  现在都经过显式 root-containment 校验，并新增路径遍历与 skill 导入边界回归测试。
- **🎨 应用图标** —— Web bundle 与桌面构建输入现在包含暗色和亮色主题应用图标。

</details>

<details>
<summary>v0.8.0 —— 🔒 治理：可控 · 透明 · 可审计</summary>

- **🔒 组织级策略** —— 一个 `dvalin.policy.json` 让*公司*、而非开发者来约束 Agent：允许哪些模式、shell 命令、文件路径、工具与模型。两层(机器级 `~/.dvalincode/policy.json` + 仓库级)按**收窄**解析 —— 仓库策略只能让机器策略更严、永不放宽。没有策略文件时,行为与之前完全一致。在唯一关卡强制执行;每次拦截都是行内 `⛔ Blocked by policy` 加一条 `policy_violation` 审计事件。[策略参考 →](../POLICY-REFERENCE.md)
- **🔎 `dvalincode trust`** —— 一条命令打印本机的实时安全态势:生效策略 + 来源哈希、审计状态、运行时、依赖 —— 让审批人直接核验 Agent 能做什么、不能做什么,而不是听口头承诺。`--json` 供工具消费。
- **🧾 策略感知的审计** —— 每次运行都在 `run_start` 记录所遵循策略的哈希(以及哪些文件参与),让防篡改日志能证明*当时生效的是哪套规则*。
- **📐 可审批性方案** —— 这条主线记录在 [docs/APPROVABILITY-PLAN.md](../APPROVABILITY-PLAN.md):让 DvalinCode 能被任何公司轻松批准 —— 可控、透明、可审计。

</details>

<details>
<summary>v0.7.0 —— 🧪 桌面应用（beta）</summary>

- **🧠 记忆与全量数据导出 / 导入** —— 升级后的本地记忆机制,连同所有 Session、配置、Profile、审计日志,现在都能打包成一个文件并在另一台机器上还原。一步迁移整套环境:`dvalincode export` / `dvalincode import`,或 GUI 设置面板里的 **Export / Import** 按钮。
- **📝 任意 AI 交互都能下载为 Markdown** —— 每段对话都能存成干净的 Markdown 记录(用户消息、助手回复、工具调用 + 结果、决策,全部内联)。用侧栏里每个 Session 的下载图标、`dvalincode session md <id>`,或 `GET /api/sessions/:id/markdown`。
- **🖥️ 原生桌面应用** —— 一个真正的应用窗口（不是浏览器标签页），跑在同一套内核之上：macOS 的 `DvalinCode.app`，外加 Windows / Linux 版本。基于 [webview-bun](https://github.com/tr1ckydev/webview-bun)，使用系统原生 webview（WKWebView / WebView2 / WebKitGTK）—— 不用 Electron，仍是小巧自包含的二进制。
- **🧩 第三个前端，同一内核** —— 桌面应用、终端 UI、Web GUI 都驱动同一套共享回合执行器。现有的 `dvalincode` 二进制现在纯粹定位为 **CLI**（终端 + `serve`）。
- **状态：** 桌面二进制目前**实验性 / 未验证** —— 请从最新的 **pre-release** 下载，并反馈窗口在你系统上的表现。

</details>

<details>
<summary>v0.6.0 —— 终端代理 · <code>serve</code> · 共享回合执行器</summary>

- **🖥️ 终端代理** —— 直接运行 `dvalincode` 进入交互式终端编码代理（Claude Code 风格）：流式输出、行内 `[y/N]` 写入审批 + 红绿 diff、`/mode` · `/clear` · `/git` · `/plan` · `/compact` · `/undo` · `/help`、Ctrl-C 中断，以及首次启动的引导式 Provider 配置。默认只读 **Chat**，可随时切换。
- **🌐 `dvalincode serve`** —— Web GUI 现在收归于一个命令，因此*同一个*二进制即可无头部署在服务器上：`dvalincode serve --host 0.0.0.0 --no-open`。
- **🧩 一套内核，两个前端** —— 终端 UI 与 Web GUI 共同驱动一个传输无关的共享回合执行器（`src/agent/session.ts`），始终保持功能对齐。

</details>

<details>
<summary>v0.5.0 —— 安全级审计日志 · Run Report · 主题切换</summary>

- **🛡️ 安全级审计日志** —— 每次 Cowork/Code 运行都向 `~/.dvalincode/audit/` 写入防篡改、哈希链式的 JSONL 日志（`run_start`、每次 `tool_call` / `file_*` / `shell_exec` / `approval`、`run_end`）。哈希链让任何事后修改都可被检测。本地编码 Agent 中尚无可验证的行为日志。[格式与威胁模型 →](../AUDIT-TRAIL.md)
- **📋 Run Report + `dvalincode report` 命令** —— 每次运行的 Markdown 摘要（读取/变更的文件、执行的命令、决策、测试结果），在 GUI 中以可折叠卡片呈现，也可在命令行查看：
  ```sh
  dvalincode report --last           # 渲染最近一次运行
  dvalincode report <run-id> --format json
  dvalincode report verify <run-id>  # ✓ 链条完好 / ✗ 在第 N 条断裂
  ```
- **🎨 主题切换** —— 在设置中选择 **暗色 / 浅色 / 跟随系统**。`跟随系统` 会实时跟随操作系统主题；选择会持久保存。

</details>

<details>
<summary>v0.4.0 —— <code>/compact</code> · <code>dvalin.json</code> 团队 playbook · 自包含二进制</summary>

- **`/compact`** —— 基于 LLM 的上下文压缩：把对话历史替换为五段式结构化摘要（目标 / 已完成 / 决策 / 当前状态 / 待办）。聊天线程中的分隔条会显示 Token 缩减量（如 `8,412 → 1,203 tokens −85%`）。
- **`dvalin.json` 团队 playbook** —— 把一组共享的自动化提示提交到仓库。侧栏自动加载，让队友无需任何手动配置即可运行相同的一键 Routine。导出按钮一键把你的个人 Routine 转换为 `dvalin.json`。
- **自包含二进制** —— 每平台单个 ~25 MB 可执行程序；无需 Node、Python、Docker。启动后自动打开浏览器。用 `bun --compile` 构建，Web UI 与服务端二进制打包在一起。

</details>

<details>
<summary>v0.3.0 —— 模式感知侧边栏 · 一行安装脚本 · 多 Profile LLM 配置</summary>

- **模式感知的侧边栏** —— Chat 显示快速提示 **Templates**，Cowork 显示 **Projects** 文件夹树，Code 显示自定义 **Routines**（一键命令如 "Run tests" / "Git status" / "Type check"）。可在侧栏中添加自己的 Routine，保存在 `localStorage`。
- **一行安装脚本** —— `curl … | bash` 自动检测系统和架构，将二进制放入 `~/.dvalincode/`，自动配置 `PATH`，无需任何包管理器依赖。
- **多 Profile LLM 配置** —— 保存命名的 (provider, model, API key) 组合，侧栏一键切换；顶栏实时显示当前 session 费用，随时横向对比不同 Provider。

</details>
