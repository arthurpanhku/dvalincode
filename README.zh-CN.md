<p align="center">
  <img src="assets/logo.png" alt="DvalinCode" width="480">
</p>

<p align="center">
  <a href="README.md">English</a> · <b>中文</b>
</p>

<p align="center">
  <a href="https://github.com/arthurpanhku/dvalincode/releases/latest"><img src="https://img.shields.io/github/v/release/arthurpanhku/dvalincode?style=for-the-badge&color=818cf8&label=Release" alt="Release"></a>
  <a href="https://github.com/arthurpanhku/dvalincode/releases"><img src="https://img.shields.io/github/downloads/arthurpanhku/dvalincode/total?style=for-the-badge&color=blue&label=Downloads" alt="Downloads"></a>
  <a href="#-测试"><img src="https://img.shields.io/badge/Tests-162%20%2F%20162%20%E2%9C%93-success?style=for-the-badge" alt="Tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/arthurpanhku/dvalincode"><img src="https://api.scorecard.dev/projects/github.com/arthurpanhku/dvalincode/badge" alt="OpenSSF Scorecard"></a>
  <a href="#-一行安装"><img src="https://img.shields.io/badge/Platforms-macOS%20·%20Windows%20·%20Linux-blue?style=for-the-badge" alt="Platforms"></a>
  <a href="#-providers"><img src="https://img.shields.io/badge/LLM-OpenAI%20·%20Claude%20·%20DeepSeek%20·%20Ollama%20·%20Groq-7C3AED?style=for-the-badge" alt="LLM Support"></a>
  <a href="README.md"><img src="https://img.shields.io/badge/i18n-EN%20·%20中文-orange?style=for-the-badge" alt="English / 中文"></a>
</p>

<p align="center">
  <b>面向高合规团队、真正可审批的 AI 编码代理。</b><br>
  <b>适合金融、医疗、政企与高保密研发场景：AI 编码必须可控、透明、可审计。</b>
</p>

<p align="center">
  <b>🔑 模型自由 · 本地优先 · 策略约束 · 审计就绪 —— 安全团队真正批得下来的编码代理。</b>
</p>

<p align="center">
  自带模型 —— DeepSeek、OpenAI、Claude (via OpenRouter)、Groq、Ollama，或任何 OpenAI 兼容端点。一键切换，无需改代码，无供应商绑定。
</p>

---

<table>
<tr><td><b>🗨️ Chat 模式</b></td><td>只读问答，附带一键提示词模板 —— 解释代码库、查找 TODO、审查变更、写测试。Agent 可读文件、可搜索，但绝不写入。</td></tr>
<tr><td><b>👥 Cowork 模式</b></td><td>先规划后执行。Agent 写出编号步骤，你点 <b>Proceed</b>，每次文件写入都需要明确批准——批准前会看到红绿 diff。</td></tr>
<tr><td><b>⚡ Code 模式</b></td><td>自主代理，全工具权限。一键运行测试、类型检查、构建、Lint（侧栏 <b>Routines</b> 面板）。macOS shell 调用在 <code>sandbox-exec</code> 沙箱内执行，网络被禁用。</td></tr>
<tr><td><b>🏦 高合规团队</b></td><td>为金融、医疗、安全敏感 SaaS、内部平台团队设计：AI 编码不仅要方便开发者，还要满足策略约束、审计、数据最小化和供应链审查。</td></tr>
<tr><td><b>🛡️ 审计日志</b></td><td>每次运行都生成防篡改、哈希链式的 JSONL 日志 —— 每次文件读写、每条命令、每次审批都被记录。Run Report 将其渲染为 Markdown；<code>dvalincode report verify</code> 可验证链条完好。<a href="docs/AUDIT-TRAIL.md">威胁模型 →</a></td></tr>
<tr><td><b>🔒 组织级策略 &amp; <code>trust</code></b></td><td>由公司、而非开发者来约束 Agent。一个 <code>dvalin.policy.json</code> 限定模式、shell 命令、文件路径、工具与模型；仓库级策略只能让机器级策略<i>更严</i>、永不放宽。每次运行都记录所遵循策略的哈希。<code>dvalincode trust</code> 直接打印本机的实时安全态势 —— 生效策略 + 哈希、审计状态、运行时 —— 让审批人自行核验。<a href="docs/APPROVABILITY-PLAN.md">可审批性方案 →</a></td></tr>
<tr><td><b>🏛️ 治理证据</b></td><td>仓库维护 OpenSSF Scorecard、CodeQL、Dependabot、固定 SHA 的 GitHub Actions、CODEOWNERS，以及 ISO/IEC 42001 AIMS 对齐文档，作为可审查的项目治理证据。<a href="docs/security/OPENSSF-SCORECARD.md">Scorecard 映射 →</a> · <a href="docs/governance/ISO-42001-AIMS.md">ISO 42001 对齐 →</a></td></tr>
<tr><td><b>🖥️ 一流的 GUI</b></td><td>现代化 Web UI，包含代码语法高亮、<code>@</code> 文件引用、<code>/</code> 斜杠命令、Git 分支显示、实时 Token 与费用统计、多 LLM Profile，以及暗色 / 浅色 / 跟随系统的主题切换。</td></tr>
<tr><td><b>🖥️ 终端或 Web，同一个二进制</b></td><td>直接运行进入交互式<b>终端代理</b>（像 Claude Code —— 流式输出、行内审批、红绿 diff）；或 <code>dvalincode serve</code> 启动 <b>Web GUI</b> 供浏览器/远程使用。两个前端共用同一套 agent 内核。</td></tr>
<tr><td><b>🪶 零依赖二进制</b></td><td>每平台单文件可执行程序 ~25MB。无需 Node、Python、Docker。</td></tr>
<tr><td><b>🔐 本地优先</b></td><td>Session、配置、Profile、审计日志均保存在 <code>~/.dvalincode/</code>。<code>.dvalincodeignore</code> 阻止 Agent 访问敏感文件。仓库根目录的 <code>AGENTS.md</code> 作为项目级持久指令自动加载。</td></tr>
<tr><td><b>💾 可导出、可迁移</b></td><td>把<b>所有</b>本地数据（记忆、Session、配置、审计）导出为一个文件，在另一台机器导入 —— 整套环境随身带走。任意对话都能下载为干净的 <b>Markdown</b> 记录。</td></tr>
</table>

---

## 🎯 核心目标

> **让高合规与安全敏感团队也能批准 AI 编码。**

DvalinCode 的定位是 **可审批的 Agent 运行时（runtime）**，而不只是又一个
编码 Agent 应用。核心产品不只是“AI 能写代码”，而是金融、医疗、政企、内部平台
等高保密代码库在引入 AI 编码前所需要的安全、合规和审计证据。

- **模型自由** —— 任何 OpenAI 兼容端点都是一等公民，包括本地模型。你的工作流不应被任何一家厂商的定价、限流或质量波动绑架。
- **默认安全** —— 三档审批 + diff 预审、撤销栈、沙箱化 shell 执行。一个敢放心开全自动的 Agent。
- **小到可审计** —— 单个 ~25MB 二进制、个位数运行时依赖、一个周末就能读完的代码库。信任来自可检查，而非口头承诺。自 v0.5 起，**每一次运行同样可审计**：一份记录所有动作、可事后验证的防篡改哈希链日志。
- **开放到可嵌入** —— Agent 核心通过干净的 REST + WebSocket API 暴露，可直接接入你自己的产品、CI 或内部工具。
- **任何公司都能批准** —— 治理是内建的，而非事后附加：组织级策略约束影响面（**可控**），`dvalincode trust` 让安全态势可自证（**透明**），哈希链日志证明每次运行做了什么（**可审计**）。这三者正是安全评审说"yes"所需要的 —— 也是上云、闭源、日志可改的 Agent 在结构上很难完整提供的。[可审批性方案 →](docs/APPROVABILITY-PLAN.md)

自带的 **Web GUI 是这个运行时的参考实现与展示窗** —— 它是这套公开 API 的第一个消费者，演示运行时的全部能力。

---

## 🛡️ 安全与治理

DvalinCode 维护项目级治理证据，便于开源用户和企业安全评审。这是面向
高合规团队的核心差异化：AI 编码工具进入生产仓库前，必须先能过安全审批。

- **OpenSSF Scorecard 支持** —— 定时 Scorecard workflow、SARIF 上传、
  CodeQL、Dependabot、CODEOWNERS、最小权限 workflow permissions，以及固定
  SHA 的 GitHub Actions。[控制映射 →](docs/security/OPENSSF-SCORECARD.md)
- **ISO/IEC 42001 对齐** —— AI 管理体系范围、AI policy、角色映射、风险登记、
  AI 变更分级、必留记录和审查节奏。[AIMS 对齐 →](docs/governance/ISO-42001-AIMS.md)
- **AI 变更影响评估** —— 面向模型/provider 行为、prompt、权限、工具、审计日志
  或发布安全变更的可复用模板。[模板 →](docs/governance/AI-CHANGE-IMPACT-ASSESSMENT.md)
- **高合规使用姿态** —— 本地优先的数据处理、策略约束的自主性、最小化审计记录，
  以及面向金融、医疗、安全敏感 SaaS 和企业内部使用的发布供应链证据。

这些文档是实现证据和运行流程，不代表项目已经获得第三方 ISO 认证。

---

## ⭐ v0.8.0 新功能 —— 🔒 治理：可控 · 透明 · 可审计

- **🔒 组织级策略** —— 一个 `dvalin.policy.json` 让*公司*、而非开发者来约束 Agent：允许哪些模式、shell 命令、文件路径、工具与模型。两层(机器级 `~/.dvalincode/policy.json` + 仓库级)按**收窄**解析 —— 仓库策略只能让机器策略更严、永不放宽。没有策略文件时,行为与之前完全一致。在唯一关卡强制执行;每次拦截都是行内 `⛔ Blocked by policy` 加一条 `policy_violation` 审计事件。
- **🔎 `dvalincode trust`** —— 一条命令打印本机的实时安全态势:生效策略 + 来源哈希、审计状态、运行时、依赖 —— 让审批人直接核验 Agent 能做什么、不能做什么,而不是听口头承诺。`--json` 供工具消费。
- **🧾 策略感知的审计** —— 每次运行都在 `run_start` 记录所遵循策略的哈希(以及哪些文件参与),让防篡改日志能证明*当时生效的是哪套规则*。
- **📐 可审批性方案** —— 这条主线记录在 [docs/APPROVABILITY-PLAN.md](docs/APPROVABILITY-PLAN.md):让 DvalinCode 能被任何公司轻松批准 —— 可控、透明、可审计。

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

- **🛡️ 安全级审计日志** —— 每次 Cowork/Code 运行都向 `~/.dvalincode/audit/` 写入防篡改、哈希链式的 JSONL 日志（`run_start`、每次 `tool_call` / `file_*` / `shell_exec` / `approval`、`run_end`）。哈希链让任何事后修改都可被检测。本地编码 Agent 中尚无可验证的行为日志。[格式与威胁模型 →](docs/AUDIT-TRAIL.md)
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

---

## 📸 预览

<p align="center">
  <img src="assets/hero.png" alt="DvalinCode UI" width="100%">
</p>

**切换模式 —— 每种模式都有不同的侧边栏：**

<p align="center">
  <img src="assets/modes.gif" alt="切换模式" width="100%">
</p>

**输入框中的斜杠命令与文件引用：**

<p align="center">
  <img src="assets/slash.gif" alt="斜杠命令与文件引用" width="100%">
</p>

---

## 🆚 什么时候选择 DvalinCode

| 如果你需要… | DvalinCode 的解法 |
|---|---|
| **安全团队真正批得下来的 Agent** | 策略约束工具权限、明确审批模式、`dvalincode trust`、审计日志、OpenSSF 证据和 ISO/IEC 42001 对齐文档。 |
| **在高合规仓库里使用 AI 编码** —— 金融、医疗、企业数据、客户保密代码 | 本地优先运行时、自带模型、`.dvalincodeignore`、受控 egress、最小化审计记录。 |
| **比通用自主编码 Agent 更安全的选择** | 产品主线是可控 / 透明 / 可审计，而不仅仅是“模型可以改文件”。 |
| **Cline / Cursor** — 绑定 IDE、安装包庞大、代码上传到云端让人不安 | 单二进制 (~25 MB)，无需任何 IDE。macOS shell 调用默认运行在 `sandbox-exec` 沙箱中——拒绝网络访问，写入范围限制在 `cwd`。 |
| **Claude Code / Aider** — 纯命令行看 Diff 太痛苦，环境配置繁琐 | CLI 启动后自动打开现代 Web UI，支持代码高亮和红绿 Diff 逐文件审批。一行安装命令，无需其他依赖。 |
| **任何云端 Agent** — 厂商锁定、频繁限速、无法使用本地模型 | 所有 OpenAI Compatible 端点均为一等公民。用 Ollama 跑 Qwen2.5-Coder：无需 API Key，无需联网，零 Token 费用。 |
| **任何 Agent** — 新队友无法复现你的 AI 配置，Routines 被锁在你的 IDE 里 | `AGENTS.md` 提交到仓库，随 `git clone` 把 AI 上下文同步给所有人。`dvalin.json` 以同样方式共享团队自动化命令集 —— 从侧栏导出、提交、完成。 |

---

## 🚀 一行安装

### macOS / Linux

```sh
curl -fsSL https://raw.githubusercontent.com/arthurpanhku/dvalincode/main/scripts/install.sh | bash
```

自动检测系统和架构、下载对应二进制、安装到 `~/.dvalincode/`、添加到 `PATH`。重新加载 shell 后：

```sh
source ~/.zshrc    # 或 ~/.bashrc
dvalincode                       # 交互式终端代理（像 Claude Code）
dvalincode serve                 # 启动 Web GUI 并打开浏览器
dvalincode serve --host 0.0.0.0 --no-open   # 部署到服务器，供远程/浏览器访问
```

### Windows

从 [Releases](https://github.com/arthurpanhku/dvalincode/releases/latest) 下载 `dvalincode-v*-windows-x64.zip`，解压后双击 `start.bat`。

### 手动下载

从 [Releases 页面](https://github.com/arthurpanhku/dvalincode/releases/latest) 获取对应平台的压缩包：

| 平台 | 文件 |
|---|---|
| macOS Apple Silicon (M1/M2/M3) | `dvalincode-v*-macos-arm64.tar.gz` |
| macOS Intel | `dvalincode-v*-macos-x64.tar.gz` |
| Windows x64 | `dvalincode-v*-windows-x64.zip` |
| Linux ARM64 | `dvalincode-v*-linux-arm64.tar.gz` |
| Linux x64 | `dvalincode-v*-linux-x64.tar.gz` |

每个 release 都附带 `SHA256SUMS.txt` 用于校验。

> **macOS Gatekeeper：** 二进制未签名。首次运行可执行 `xattr -dr com.apple.quarantine ~/.dvalincode`，或在 Finder 中右键 → 打开一次。

---

## 🎬 首次配置

**终端（默认）：** 运行 `dvalincode`。首次启动会引导你完成一次性的 Provider 配置（选择 Provider、粘贴 API Key、选择模型），保存到 `~/.dvalincode/config.json`。随后即进入对话提示符 —— 直接输入即可对话，`/mode` 切换 Chat / Cowork / Code，`/help` 查看命令。

**Web GUI：** 运行 `dvalincode serve`：

1. 服务在 `http://localhost:3000` 启动，浏览器自动打开。
2. 点击侧边栏底部的 **LLM Configuration**。
3. 选择 Provider、粘贴 API Key、选择模型、保存。
4. 可选：将当前配置保存为命名 Profile（如 `fast`、`cheap`、`local-ollama`），日后一键切换。

两种方式共享 `~/.dvalincode/` 下的同一份配置与 Session。

---

## ✨ 功能列表

| 类别 | 功能 | 说明 |
|---|---|---|
| **模式** | Chat / Cowork / Code | 各自独立的侧边栏（Templates / Projects / Routines）与工具权限策略 |
| **Code 权限** | Ask Permissions / Plan Mode / Auto Mode / Bypass permissions | 已验证行为：Ask 在写入/命令前请求批准，Plan 只读且不写文件，Auto 自动执行操作，Bypass 不再弹出确认 |
| **工作区** | 打开文件夹 / 导入 Git / 添加 worktree | Cowork 与 Code 可在 UI 中切换到本地文件夹、克隆 Git 项目，或创建 Git worktree |
| **治理** | OpenSSF Scorecard / ISO 42001 AIMS 对齐 | Scorecard、CodeQL、Dependabot、固定 SHA 的 Actions、AI 影响评估、风险登记和审查节奏记录在 `docs/security/` 与 `docs/governance/` |
| **输入框** | `@` 文件引用 | 输入 `@` 触发模糊文件搜索，选中文件自动插入到 prompt |
| | `/` 斜杠命令 | `/clear` `/compact` `/git` `/plan` `/undo` `/help` |
| | 多行输入 + 中断 | <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行，Stop 按钮中断生成 |
| **工具 UI** | 行内 diff | `edit_file` 与 `write_file` 结果以红绿统一 diff 呈现，默认折叠 |
| | 审批对话框含 diff | Cowork 模式下，文件变更在执行前显示 diff |
| | 实时工具计数 + Token + 费用 | 顶栏实时显示当前 session 累计数据 |
| **Agent** | LLM 上下文压缩 | `/compact` 将历史压缩为 目标/已完成/决策/待办 结构化摘要 |
| | 持久化 Undo 栈 | `/undo [N]` 撤销最近 N 个工具调用 |
| | Run Report | 每次运行的 Markdown 摘要（文件、命令、决策、测试结果）—— GUI 卡片 + `dvalincode report` |
| | Git 感知 | 顶栏显示分支名；`git_status` 工具；Git 上下文自动注入 prompt |
| | `AGENTS.md` 项目记忆 | 每个仓库的持久指令，每轮对话自动加载 |
| **安全** | 防篡改审计日志 | 每次运行在 `~/.dvalincode/audit/` 生成哈希链 JSONL；`dvalincode report verify` 可检测修改 |
| | macOS Shell 沙箱 | `sandbox-exec` 拒绝网络；写入仅限 cwd 与 `/tmp` |
| | `.dvalincodeignore` | 类 gitignore 排除；阻止 `read_file` / `list_files` / `search_text` |
| | 逐操作审批 | Cowork 模式下每次写入/删除/shell 都需用户批准 |
| **外观** | 主题切换 | 暗色 / 浅色 / 跟随系统，持久保存；`跟随系统` 实时跟随 OS |
| **Providers** | OpenAI 兼容端点 | DeepSeek · OpenAI · Groq · OpenRouter · Ollama · 自定义 |
| | 多 Profile 配置 | 保存并切换多组 (provider, model, API key) 命名配置 |
| **Session** | 自动保存与恢复 | 所有 session 以 JSON 持久化到 `~/.dvalincode/sessions/` |
| | LLM 摘要记忆 | 跨 session 摘要在重启后保持 Agent 上下文 |
| **记忆** | 本地用户/项目记忆 | 可搜索的事实、偏好、决策,存于 `~/.dvalincode/memory/`;支持从 Claude/Hermes/Markdown 导入 |
| **数据可迁移** | 导出 / 导入全部数据 | 记忆 + Session + 配置 + 审计打包成一个文件 —— `dvalincode export` / `import`,或 GUI 设置 → Export / Import |
| | Markdown 记录 | 任意对话下载为 Markdown —— 侧栏下载图标、`dvalincode session md <id>`,或 `/api/sessions/:id/markdown` |

---

## ⌨️ 斜杠命令

| 命令 | 说明 |
|---|---|
| `/clear` | 清空当前对话（客户端，开启新 session） |
| `/compact` | 调用 LLM 生成结构化摘要压缩上下文 |
| `/undo [N]` | 撤销最近 N 个工具调用（默认 1） |
| `/git` | 执行 `git_status`，显示分支、最近提交、变更文件 |
| `/plan <task>` | 让 Agent 逐步规划任务而**不**执行 |
| `/help` | 显示所有可用命令 |

> 审计日志通过 `dvalincode report` **命令行**查看（`--last` / `<run-id>` / `verify`），不是斜杠命令。

---

## 🛠️ 架构

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
└─────────────────────────────────────────────────────────┘
```

### Agent Loop — 8 状态

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

---

## 🧪 测试

```sh
npm test
```

**95 个测试 · 18 个文件 · 全部通过。**

---

## 🏗️ 源码构建

需要 [Bun](https://bun.sh)（`curl -fsSL https://bun.sh/install | bash`）。

```sh
git clone https://github.com/arthurpanhku/dvalincode
cd dvalincode
npm install
npm run dev:all                 # 后端 (3001) + Vite (5173)
```

构建所有平台 release 二进制：

```sh
bash scripts/build-release.sh   # → release/ 包含 tar.gz / zip + SHA256SUMS.txt
bash scripts/build-release.sh darwin    # 仅 macOS
bash scripts/build-release.sh windows   # 仅 Windows
```

发布前校验：

```sh
(cd release && shasum -a 256 -c SHA256SUMS.txt)
unzip -l release/dvalincode-v*-windows-x64.zip | grep 'web/dist/index.html'
tar tzf release/dvalincode-v*-macos-arm64.tar.gz | grep 'DvalinCode.app/Contents/Resources/AppIcon.icns'
```

Windows 冒烟测试：在 Windows 上解压 `dvalincode-v*-windows-x64.zip` 并从解压目录运行 `start.bat`。服务应打开 `http://localhost:3000`。若报出 `B:\~BUN\root\web\dist` 下的 `ENOENT` 路径，说明编译后的 Bun 虚拟路径检测退化了；打包后的二进制必须将 `web/dist` 解析到解压出的可执行文件旁边。

注意：Bun 仅在 Windows 上编译时才允许注入 Windows `.exe` 图标/元数据。macOS/Linux 交叉编译仍会产出有效的 Windows 压缩包，但不带内嵌的 `.exe` 图标。

---

## 🌐 Providers

DvalinCode 支持任意 OpenAI 兼容端点。内置预设，按价格排序：

| Provider | 最便宜模型 | 输入 / 输出价格 | 说明 |
|---|---|---|---|
| **Groq** | `llama-3.1-8b-instant` | 免费额度 | 最快的开源模型 —— Llama 3.3 70B、Mixtral |
| **Ollama** | `qwen2.5-coder` | $0（本地）| 无需 API Key，本机运行 |
| **DeepSeek** | `deepseek-chat` | $0.14 / $0.28 每 1M | 便宜且强；v3 几乎媲美 GPT-4 质量 |
| **OpenRouter** | `google/gemini-2.0-flash-001` | $0.10 / $0.40 每 1M | 200+ 模型，包括 Claude、Gemini、Llama |
| **OpenAI** | `gpt-4o-mini` | $0.15 / $0.60 每 1M | 可靠；`o1` 用于深度推理 |
| **Custom** | — | 取决于服务方 | 任意 OpenAI 兼容 base URL |

DvalinCode 顶栏实时显示本 session 的费用 —— 在 **LLM Configuration** 中切换 Provider、保存命名 Profile、实时比较。

---

## ❓ 常见问题

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
每种模式有不同的<b>工具权限</b>和<b>安全默认值</b>：Chat 只读；Cowork 每次写入都需要批准；Code 全自动。三种模式还有不同的侧边栏（Templates / Projects / Routines）面向不同工作流。任何时候都可切换 —— 对话延续。
</details>

<details>
<summary><b>Shell 工具有沙箱吗？</b></summary>
<br>
macOS 上有 —— 每次 <code>shell</code> 调用都包在 <code>sandbox-exec</code> 里，profile <i>拒绝网络访问</i>，仅允许写入 <code>cwd</code>、<code>/tmp</code>、<code>/var</code>。Linux 和 Windows 沙箱已规划中。
</details>

<details>
<summary><b>怎么查看 Agent 到底做了什么 —— 日志可信吗？</b></summary>
<br>
每次运行都向 <code>~/.dvalincode/audit/run-&lt;timestamp&gt;-&lt;id&gt;.jsonl</code> 写入 JSONL 审计日志。用 <code>dvalincode report --last</code> 渲染（或在 GUI 看可折叠的 Run Report 卡片）。每条记录都用 SHA-256 哈希与上一条相连，因此任何事后修改都可被检测 —— <code>dvalincode report verify &lt;run-id&gt;</code> 会报告 <code>✓ chain intact</code> 或断裂的确切位置。它是防篡改<b>可检测</b>，而非<b>不可篡改</b>：能重写整个文件的本地攻击者可重算整条链。其价值在于取证与可问责。完整威胁模型见 <a href="docs/AUDIT-TRAIL.md">docs/AUDIT-TRAIL.md</a>。
</details>

<details>
<summary><b>会不会不经询问就覆盖我的文件？</b></summary>
<br>
取决于模式。<b>Chat</b> 永不写入；<b>Cowork</b> 每个文件都需逐一批准（批准前可见红绿 diff）；<b>Code</b> 全自动 —— 适合受信任的任务或在 feature 分支上使用。
</details>

<details>
<summary><b>macOS 二进制无法打开 —— "未验证的开发者"</b></summary>
<br>
二进制未签名。执行一次清除隔离标记：
<pre><code>xattr -dr com.apple.quarantine ~/.dvalincode</code></pre>
或在 Finder 中右键 → 打开 → 确认。
</details>

<details>
<summary><b>Code 模式怎么保存 Routine？</b></summary>
<br>
切到 Code 模式，点击侧栏 "ROUTINES" 旁的 <b>+</b>。输入名字（如 "Deploy preview"）和 prompt 或斜杠命令（如 "<code>/git</code>" 或 "构建项目并部署到 staging"）。Routine 保存在浏览器 <code>localStorage</code>。
</details>

<details>
<summary><b><code>AGENTS.md</code> 每轮都会发送吗？</b></summary>
<br>
是的 —— DvalinCode 每轮对话前读取项目根目录的 <code>AGENTS.md</code>，注入系统 prompt 的 <code>=== PROJECT INSTRUCTIONS ===</code> 段。保持精简 —— 它会占用 token 预算。
</details>

---

## 🤝 贡献

欢迎贡献！代码库保持紧凑、不堆叠 —— 详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```sh
git clone https://github.com/arthurpanhku/dvalincode
cd dvalincode && npm install
npm test                # 65/65 ✅
npm run typecheck
```

---

## 📄 License

MIT —— 详见 [LICENSE](LICENSE)。

---

## 🔗 独立声明与致谢

DvalinCode 与 Anthropic、Claude、OpenAI 或任何其他供应商**无任何关联**。

设计过程参考了现代编码 Agent 的常见模式以学习架构。`TurnState` 状态机设计参考了 [HKUDS/nanobot](https://github.com/HKUDS/nanobot)（MIT）。Agent 循环遵循 [ReAct 范式](https://arxiv.org/abs/2210.03629)（Yao et al., 2022），工具调用接口遵循 OpenAI `tool_calls` 格式。其余实现 —— 状态机、UI、工具 schema、模块布局 —— 均为原创；未抄袭任何其他项目的源代码、prompt 或 UI 文本。

完整来源参考：[docs/REFERENCES.md](docs/REFERENCES.md)

---

## ⭐ Star 增长趋势

<p align="center">
  <a href="https://www.star-history.com/#arthurpanhku/dvalincode&Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=arthurpanhku/dvalincode&type=Date&theme=dark">
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=arthurpanhku/dvalincode&type=Date">
      <img alt="DvalinCode Star 增长趋势图" src="https://api.star-history.com/svg?repos=arthurpanhku/dvalincode&type=Date">
    </picture>
  </a>
</p>
