<p align="center">
  <img src="assets/logo.png" alt="DvalinCode" width="480">
</p>

<p align="center">
  <a href="README.md">English</a> · <b>中文</b> · <a href="https://dvalincode.dev/zh/">🌐 dvalincode.dev</a>
</p>

<p align="center">
  <a href="https://github.com/arthurpanhku/dvalincode/releases/latest"><img src="https://img.shields.io/github/v/release/arthurpanhku/dvalincode?style=for-the-badge&color=818cf8&label=Release" alt="Release"></a>
  <a href="https://github.com/arthurpanhku/dvalincode/releases"><img src="https://img.shields.io/github/downloads/arthurpanhku/dvalincode/total?style=for-the-badge&color=blue&label=Downloads" alt="Downloads"></a>
  <a href="#-测试"><img src="https://img.shields.io/badge/Tests-819%20%2F%20819%20%E2%9C%93-success?style=for-the-badge" alt="Tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/arthurpanhku/dvalincode"><img src="https://api.scorecard.dev/projects/github.com/arthurpanhku/dvalincode/badge" alt="OpenSSF Scorecard"></a>
  <a href="#-两个产品cli-和桌面应用"><img src="https://img.shields.io/badge/Platforms-macOS%20·%20Windows%20·%20Linux-blue?style=for-the-badge" alt="Platforms"></a>
  <a href="#-providers"><img src="https://img.shields.io/badge/LLM-OpenAI%20·%20Claude%20·%20DeepSeek%20·%20Ollama%20·%20Groq-7C3AED?style=for-the-badge" alt="LLM Support"></a>
  <a href="README.md"><img src="https://img.shields.io/badge/i18n-EN%20·%20中文-orange?style=for-the-badge" alt="English / 中文"></a>
</p>

<p align="center">
  <b>为人类和 AI Agent 编写的代码提供开放安全工程能力。</b><br>
  <b>每一次修复，都自带证明。</b>
</p>

Agent 修好了一个安全问题之后，总得有人判断它到底修好没有。市面上几乎所有工具都是
去问那个写下修复的模型 —— 而这恰恰是模型最无法违背自身利益去诚实回答的问题。

**Dvalin 自己来判断，并把证明交给你。** 它重新扫描、亲自跑你项目的测试，看的是它
自己启动的进程返回的退出码。修复是谁写的 —— 我们的 agent、Claude Code、Codex、
Copilot，还是人 —— 只被记录，绝不参与判定。产物是一份 **Verified Fix Record**：
一个很小的 JSON，任何人都能离线复验，不需要联网，也不需要任何 Dvalin 的本地状态。

```sh
dvalin verify-fix fix-record.json
```
```
Fix record 2c9d71ac03e0 · VERIFIED · scan-and-checks
  executor: claude-code (recorded, not consulted)
  targets: 1 before · 0 remaining
  coverage: complete → complete
  introduced: 0 (gate high/new)
  outcome: verified
  ✓ test: npm run test (exit 0)
  audit: run verify-36509f42 @ 414644c75af0
```

这份记录声称的东西刻意很窄：*这些 finding 消失了，这些检查被观察到通过了。* 它不是
「你的代码安全了」这种断言，Dvalin 也不允许它被这样解读 —— 每份记录都带着这次扫描
究竟覆盖了什么，而一个没有任何检查能确认的修复，不会通过。
[开放规范 →](docs/spec/FIX-VERIFICATION.md)

修复本身也是一次改动，而改动既会移除问题，也可能带来新问题。所以记录里还带着复扫
看到、而首扫没有看到的东西，以及这次判定所依据的门禁阈值：一个删掉了 `eval`、却引入
了 SQL 注入的修复，会被记为 `regressed`，不予通过。签发方根本没去看的记录同样不通过
—— `introduced: not determined` 直接失败，因为「不去查」绝不能比「查了并且查出问题」
得分更高。

Dvalin 是放在“代码生成”和“允许合并”之间的独立安全运行时。人类开发者、Coding
Agent 和 CI 调用同一套版本化协议完成发现、修复与验证。它既可以独立运行，也可以通过
密封扫描工件或可移植 SARIF 与 Codex Security 等专业系统互操作。内置 Coding 能力只负责可靠地执行
聚焦修复，不是安全结论的信任边界，也不以打败所有通用 Coding Agent 为目标。
详见[安全 Agent 战略](docs/SECURITY-AGENT-STRATEGY.md)。

---

## 🧭 两个产品：CLI 和桌面应用

DvalinCode 以两个产品发布，底下是同一个引擎。无论用哪一个，策略、审批、审计链和验证
都是同一套；不同的只是你和它打交道的方式。

| | CLI | 桌面应用 |
|---|---|---|
| **适合** | 终端与自动化：提交门禁和 CI 门禁、PR、无头运行，以及你已经在用的编码 Agent | 在窗口里工作：和 Agent 对话、看它的 diff、逐个审批改动，以及使用 Dvalin 安全工作区 |
| **平台** | macOS · Linux · Windows | macOS · Windows |
| **发布方式** | `v*` tag · npm · Homebrew | `gui-v*` tag |
| **文档** | [CLI 指南 →](docs/zh/cli.md) | [桌面应用指南 →](docs/zh/gui.md) |

30 秒试一下扫描器，不用安装，也不需要 API Key：

```sh
npx dvalincode security scan .
```

在 macOS 或 Linux 上安装 CLI：

```sh
curl -fsSL https://raw.githubusercontent.com/arthurpanhku/dvalincode/main/scripts/install.sh | bash
```

在 macOS 上安装桌面应用（Windows 上请从[最新的桌面版发布](https://github.com/arthurpanhku/dvalincode/releases?q=gui-v)
下载并运行 `dvalincode-gui-v*-windows-x64-setup.exe`）：

```sh
curl -fsSL https://raw.githubusercontent.com/arthurpanhku/dvalincode/main/scripts/install.sh | bash -s -- --gui
```

Homebrew、Windows 和手动下载见各自的指南。[每个版本的新功能 →](docs/zh/whats-new.md)

---

## 🛡️ 上面那次运行到底做了什么

<p align="center">
  <img src="assets/dvalin-remediation.gif" alt="Dvalin 扫描有漏洞的 OWASP NodeGoat 示例得到 22/100 F 与 10 条发现，修复后复扫为 100/100 A" width="100%">
</p>

这段动图来自真实应用，不是设计稿。输入代码改编自 Apache-2.0
许可的 [OWASP NodeGoat](https://github.com/OWASP/NodeGoat/tree/c5cb68a7084e4ae7dcc60e6a98768720a81841e8/app/routes)，
原始 contribution route 会执行用户可控文本。

Dvalin 把开源扫描器的证据组织成受控的“扫描 → 修复 → 测试 → 复扫 → Draft PR”
闭环。上面动图里那次运行，量化如下：

| NodeGoat 改编案例真实运行 | 修复前 | Dvalin 修复后 |
|---|---:|---:|
| 安全健康分（分诊启发式） | 22 / 100 · F | 100 / 100 · A |
| 发现项 | 10 条（2 个引擎、3 条规则命中 `eval`） | 0 条 |
| 测试 | 2 条通过 | 3 条通过，新增注入回归测试 |
| 扫描器 | 4 / 4 完成 | 4 / 4 完成 |

扫描与加固的**控制平面**采用开源组件：

- [Semgrep CE](https://github.com/semgrep/semgrep) 与社区规则：语义 SAST。
- [Trivy](https://github.com/aquasecurity/trivy)：文件系统漏洞、Secrets 与错误配置。
- [OSV-Scanner](https://github.com/google/osv-scanner) 与开放的
  [OSV 数据库](https://osv.dev/)：依赖漏洞。
- DvalinCode 自身 MIT 许可的内置规则、修复编排、测试/复扫门禁，以及用于接入
  其他扫描器的 [SARIF 2.1](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html)。

扫描器负责发现和排序证据；配置的模型提出源码修改；DvalinCode 约束执行范围、
记录 diff、运行项目测试、重新扫描变更树，并要求用户显式发布 PR。它不会自动合并，
也不会把一次干净扫描宣称为“没有漏洞”。若修复建议也必须完全本地、开放，可通过
Ollama 选择开放权重模型；托管模型的许可取决于相应 provider。

事后仍可证明 agent 做过什么：

```sh
dvalincode report verify    # 重新推导上次运行审计日志的哈希链
```

---

## 🏛️ 而且它过得了安全评审

当依赖这套工具的不止你一个人时，上面那条命令才是真正要紧的东西。DvalinCode 是一个
完整的编码代理 —— 终端、Web GUI、桌面应用 —— 但它的设计前提是：**由组织、而不是
开发者本人**来划定它能做什么。策略文件约束模式、命令、路径、工具和模型；每次运行
都以哈希链写入防篡改审计日志；没有被出网守卫放行的东西不会到达任何 provider。
仓库级策略只能**收紧**机器级策略，永远不能放宽。

如果你正是那个需要审批这类工具的人，请从
[APPROVABILITY-PLAN.md](docs/APPROVABILITY-PLAN.md) 和每个版本随包发布的
[Evidence Pack](docs/EVIDENCE-PACK.md) 开始看。

---

<table>
<tr><td><b>🏠 Home</b></td><td>统一容纳只读 <b>Ask</b> 与逐操作审批的 <b>Collaborate</b>，切换意图时不离开当前项目和对话。</td></tr>
<tr><td><b>⚡ Code</b></td><td>专注自主编码，支持 Ask / Plan / Auto / Bypass 权限级别；旧 Security 与 Routines 已从 Code 移除。</td></tr>
<tr><td><b>🛡️ Dvalin</b></td><td>专用白盒安全工程工作区：编排内置扫描器、Semgrep CE、Trivy、OSV-Scanner，分诊并修复发现项，运行测试和复扫，最后显式发布可审查的 Draft PR。<a href="docs/DVALIN.md">Dvalin 指南 →</a></td></tr>
<tr><td><b>🏦 高合规团队</b></td><td>为金融、医疗、安全敏感 SaaS、内部平台团队设计：AI 编码不仅要方便开发者，还要满足策略约束、审计、数据最小化和供应链审查。</td></tr>
<tr><td><b>🛡️ 安全修复闭环</b></td><td>运行本地安全扫描，或导入 CodeQL、GitHub Code Scanning、Semgrep 及兼容扫描器的 SARIF；随后创建隔离 remediation worktree，把发现项转成带源码上下文和 PR 就绪报告的聚焦修复任务。<a href="docs/SECURE-REMEDIATION.md">流程 →</a></td></tr>
<tr><td><b>📚 Skills</b></td><td>上传、下载和查看本地 skill bundle。DvalinCode 内置 secure-code-scan 与 secure-code-remediation skills，并提供列出 skill、读取 skill 说明、扫描、列出 case、准备 remediation worktree 的 agent tools。<a href="docs/SKILLS.md">格式 →</a></td></tr>
<tr><td><b>🛡️ 审计日志</b></td><td>每次运行都生成防篡改、哈希链式的 JSONL 日志 —— 每次文件读写、每条命令、每次审批都被记录。Run Report 将其渲染为 Markdown；<code>dvalincode report verify</code> 可验证链条完好。<a href="docs/AUDIT-TRAIL.md">威胁模型 →</a></td></tr>
<tr><td><b>🔒 组织级策略 &amp; <code>trust</code></b></td><td>由公司、而非开发者来约束 Agent。一个 <code>dvalin.policy.json</code> 限定模式、shell 命令、文件路径、工具与模型；仓库级策略只能让机器级策略<i>更严</i>、永不放宽。每次运行都记录所遵循策略的哈希。<code>dvalincode trust</code> 直接打印本机的实时安全态势 —— 生效策略 + 哈希、审计状态、运行时 —— 让审批人自行核验。<a href="docs/POLICY-REFERENCE.md">策略参考 →</a> · <a href="docs/APPROVABILITY-PLAN.md">可审批性方案 →</a></td></tr>
<tr><td><b>🏛️ 治理证据</b></td><td>仓库维护 OpenSSF Scorecard、CodeQL、Dependabot、固定 SHA 的 GitHub Actions、CODEOWNERS，以及 ISO/IEC 42001 AIMS 对齐文档，作为可审查的项目治理证据；每个 release 还附带一份由该二进制给自己生成的 Evidence Pack。<a href="docs/security/OPENSSF-SCORECARD.md">Scorecard 映射 →</a> · <a href="docs/governance/ISO-42001-AIMS.md">ISO 42001 对齐 →</a> · <a href="docs/RELEASE-EVIDENCE.md">发布证据 →</a></td></tr>
<tr><td><b>📐 开放规范</b></td><td><b>PCP-1</b> —— 把模型提供方边界的约束（出网收敛、凭据收敛、审计、策略绑定）写成与厂商无关、带测试步骤的开放规范，任何 agent 运行时都可以拿它跑自己的 adapter 并公开结果。它不是 DvalinCode 的一个测试文件，而是别人同样可以用来衡量我们的清单。<a href="docs/spec/PROVIDER-CONFORMANCE.md">Provider Conformance Profile →</a></td></tr>
<tr><td><b>🖥️ 一流的 GUI</b></td><td>现代化 Web UI，包含代码语法高亮、<code>@</code> 文件引用、<code>/</code> 斜杠命令、Git 分支显示、实时 Token 与费用统计、多 LLM Profile，以及暗色 / 浅色 / 跟随系统的主题切换。</td></tr>
<tr><td><b>🖥️ 终端或 Web，同一个二进制</b></td><td>直接运行进入交互式<b>终端代理</b>，支持流式输出、行内审批和红绿 diff；或 <code>dvalincode serve</code> 启动 <b>Web GUI</b> 供浏览器/远程使用。两个前端共用同一套 agent 内核。</td></tr>
<tr><td><b>🖥️ 原生桌面应用</b></td><td><code>DvalinCode.app</code> —— 真正的 Dock 应用（系统原生 webview，非 Electron），驱动同一套引擎。macOS 上给一行安装命令加 <code>--gui</code> 即可装进 <code>/Applications</code>，从启动台直接打开。Windows 上有按用户安装的安装包，带开始菜单项和卸载项 —— 不需要管理员权限，不弹 UAC，也不用浏览器标签页。</td></tr>
<tr><td><b>🪶 零依赖二进制</b></td><td>每平台单文件可执行程序 ~25MB。无需 Node、Python、Docker。</td></tr>
<tr><td><b>🔐 本地优先</b></td><td>Session、配置、Profile、审计日志均保存在 <code>~/.dvalincode/</code>。<code>.dvalincodeignore</code> 阻止 Agent 访问敏感文件。仓库根目录的 <code>AGENTS.md</code> 作为项目级持久指令自动加载。</td></tr>
<tr><td><b>💾 可导出、可迁移</b></td><td>把<b>所有</b>本地数据（记忆、Session、配置、审计）导出为一个文件，在另一台机器导入 —— 整套环境随身带走。任意对话都能下载为干净的 <b>Markdown</b> 记录。</td></tr>
</table>

---

## 🎯 核心目标

> **让每一个写代码的人类或 Agent，都通过同一套独立安全门禁。**

DvalinCode 的定位是 **Agent 可调用的安全运行时**，而不是又一个通用 Coding Agent
榜单参赛者。核心产品是扫描证据、策略、基线、确定性验证，以及能被人类、外部 Agent
和 CI 共同调用的便携接口。自带 Coding Agent 只需保持可靠完成聚焦修复和测试的能力；
模型的文字声明永远不能决定安全 gate 是否通过。

- **模型自由** —— 任何 OpenAI 兼容端点都是一等公民，包括本地模型。你的工作流不应被任何一家厂商的定价、限流或质量波动绑架。
- **默认安全** —— 三档审批 + diff 预审、撤销栈、沙箱化 shell 执行。一个敢放心开全自动的 Agent。
- **小到可审计** —— 单个 ~25MB 二进制、个位数运行时依赖、一个周末就能读完的代码库。信任来自可检查，而非口头承诺。自 v0.5 起，**每一次运行同样可审计**：一份记录所有动作、可事后验证的防篡改哈希链日志。
- **开放到可嵌入** —— Agent 核心通过干净的 REST + WebSocket API 暴露，可直接接入你自己的产品、CI 或内部工具。
- **任何公司都能批准** —— 治理是内建的，而非事后附加：组织级策略约束影响面（**可控**），`dvalincode trust` 让安全态势可自证（**透明**），哈希链日志证明每次运行做了什么（**可审计**）。这三者正是安全评审说"yes"所需要的 —— 也是上云、闭源、日志可改的 Agent 在结构上很难完整提供的。[可审批性方案 →](docs/APPROVABILITY-PLAN.md)

自带的 **Web GUI 是这个运行时的参考实现与展示窗** —— 它是这套公开 API 的第一个消费者，演示运行时的全部能力。

---

## ✅ 为什么团队选择 DvalinCode

DvalinCode 的差异化在于 **可审批性**。它面向那些必须先通过安全、合规与数据治理评审，才能让 AI 编码接触生产仓库的团队。

- **闭环安全修复** —— 本地扫描或导入 CodeQL、GitHub Code Scanning、Semgrep
  及兼容扫描器的 SARIF；将发现项持久化为本地 remediation cases；创建隔离
  `dvalin/remediate/...` worktree；再生成带源码上下文和验证说明的聚焦修复 prompt。
- **Skills 作为受治理的操作流程** —— 上传、下载和查看本地 skill bundle。
  内置安全扫描与修复 skills 会告诉 agent 该调用哪些工具，并让流程能跨机器迁移。
- **模型自由但策略不漂移** —— 可使用 DeepSeek、OpenAI、Claude via OpenRouter、
  Groq、Ollama 或任何 OpenAI 兼容端点，同时保持工具权限、审计和 workspace policy 一致。
- **安全证据，而不只是安全口号** —— OpenSSF Scorecard 支持、CodeQL、Dependabot、
  固定 SHA 的 Actions、CODEOWNERS、ISO/IEC 42001 对齐文档、AI 变更影响记录、
  哈希链运行日志，都是项目的一部分。
- **默认本地优先** —— Session、配置、Profile、记忆和审计日志保存在
  `~/.dvalincode/`；`.dvalincodeignore` 和策略控制限制 agent 能读、写、执行什么。

---

## 🛡️ 安全与治理

<p align="center">
  <a href="docs/governance/ISO-42001-AIMS.md"><img src="https://img.shields.io/badge/ISO%2FIEC%2042001-AIMS%20Aligned-0F766E?style=for-the-badge" alt="ISO/IEC 42001 AIMS aligned"></a>
  <a href="docs/EVIDENCE-PACK.md"><img src="https://img.shields.io/badge/Compliance-Evidence%20Pack-2563EB?style=for-the-badge" alt="Compliance evidence pack"></a>
  <a href="docs/security/OPENSSF-SCORECARD.md"><img src="https://img.shields.io/badge/DevSecOps-Native-B91C1C?style=for-the-badge" alt="DevSecOps native"></a>
</p>

DvalinCode 维护项目级治理证据，便于开源用户和企业安全评审。这是面向
高合规团队的核心差异化：AI 编码工具进入生产仓库前，必须先能过安全审批。

- **威胁模型** —— 覆盖 agentic coding runtime 的完整攻击面（恶意 `AGENTS.md`、
  被投毒的 MCP server、prompt-injection 提权、egress、审计篡改、供应链、
  沙箱逃逸），并将每个风险映射到防护控制和诚实的剩余缺口。
  [威胁模型 →](docs/THREAT-MODEL.md)
- **OpenSSF Scorecard 支持** —— 定时 Scorecard workflow、SARIF 上传、
  CodeQL、Dependabot、CODEOWNERS、最小权限 workflow permissions，以及固定
  SHA 的 GitHub Actions。[控制映射 →](docs/security/OPENSSF-SCORECARD.md)
- **ISO/IEC 42001 对齐** —— AI 管理体系范围、AI policy、角色映射、风险登记、
  AI 变更分级、必留记录和审查节奏。[AIMS 对齐 →](docs/governance/ISO-42001-AIMS.md)
- **AI 变更影响评估** —— 面向模型/provider 行为、prompt、权限、工具、审计日志
  或发布安全变更的可复用模板。[模板 →](docs/governance/AI-CHANGE-IMPACT-ASSESSMENT.md)
- **高合规使用姿态** —— 本地优先的数据处理、策略约束的自主性、最小化审计记录，
  以及面向金融、医疗、安全敏感 SaaS 和企业内部使用的发布供应链证据。
- **安全修复闭环** —— 内置本地扫描与 SARIF 导入，可把 CodeQL、GitHub Code
  Scanning、Semgrep 及兼容扫描器的发现项转成本地 remediation cases 和隔离
  worktree 修复任务，并带源码上下文、验证说明和报告说明。
  [流程 →](docs/SECURE-REMEDIATION.md)

这些文档是实现证据和运行流程，不代表项目已经获得第三方 ISO 认证。

---

## 🆚 什么时候选择 DvalinCode

| 如果你需要… | DvalinCode 的解法 |
|---|---|
| **安全团队真正批得下来的 Agent** | 策略约束工具权限、明确审批模式、`dvalincode trust`、审计日志、OpenSSF 证据和 ISO/IEC 42001 对齐文档。 |
| **在高合规仓库里使用 AI 编码** —— 金融、医疗、企业数据、客户保密代码 | 本地优先运行时、自带模型、`.dvalincodeignore`、受控 egress、最小化审计记录。 |
| **比通用自主编码 Agent 更安全的选择** | 产品主线是可控 / 透明 / 可审计，而不仅仅是“模型可以改文件”。 |
| **偏 IDE 的 AI 工作流** | 单二进制 (~25 MB)，无需任何 IDE。macOS shell 调用默认运行在 `sandbox-exec` 沙箱中——拒绝网络访问，写入范围限制在 `cwd`。 |
| **偏终端的 AI 工作流** | CLI 启动后自动打开现代 Web UI，支持代码高亮和红绿 Diff 逐文件审批。一行安装命令，无需其他依赖。 |
| **仅云端的 AI 工作流** | 所有 OpenAI Compatible 端点均为一等公民。用 Ollama 跑 Qwen2.5-Coder：无需 API Key，无需联网，零 Token 费用。 |
| **单机 AI 配置** | `AGENTS.md` 提交到仓库，随 `git clone` 把 AI 上下文同步给所有人。`dvalin.json` 以同样方式共享团队自动化命令集 —— 从侧栏导出、提交、完成。 |

---

## ✨ 功能列表

| 类别 | 功能 | 说明 |
|---|---|---|
| **模式** | Home / Code / Dvalin | Home 包含只读 Ask 与审批式 Collaborate；Code 专注开发；Dvalin 是扫描到修复的安全工作区 |
| **Code 权限** | Ask Permissions / Plan Mode / Auto Mode / Bypass permissions | 已验证行为：Ask 在写入/命令前请求批准，Plan 只读且不写文件，Auto 自动执行操作，Bypass 不再弹出确认 |
| **工作区** | 打开文件夹 / 导入 Git / 添加 worktree | Home、Code 与 Dvalin 可使用本地文件夹、Git 项目和隔离 remediation worktree |
| **治理** | OpenSSF Scorecard / ISO 42001 AIMS 对齐 | Scorecard、CodeQL、Dependabot、固定 SHA 的 Actions、AI 影响评估、风险登记和审查节奏记录在 `docs/security/` 与 `docs/governance/` |
| **安全修复** | 内置 + Semgrep CE + Trivy + OSV-Scanner / SARIF / 测试 / Draft PR | Dvalin 检测已安装引擎、统一 SARIF、风险评分、驱动证据化修复、验证变更，并只在用户显式操作后发布 Draft PR |
| **Agent 集成** | `dvalin agents` / MCP server | 找出这台机器上的 Claude Code、Codex、Cursor、VS Code、Gemini CLI 和 OpenCode，把 Dvalin 的 MCP server 接进每一个，加 `--yes` 才写入；也可以交给 CC Switch 同步。[编辑器与 MCP →](integrations/mcp/) |
| **Skills** | 上传 / 下载 / 内置安全 skills | Skills 保存在 `~/.dvalincode/skills`；内置 skills 用专门的 agent tools 引导安全扫描与修复。[格式 →](docs/SKILLS.md) |
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
│  web_search · web_fetch                                 │
│  git_log · git_show · git_blame · update_plan           │
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

**819 个核心测试 · 95 个文件 · 全部通过。** VS Code 扩展另有 37 个测试，
以及一个可选的已发布包集成测试。

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

Windows 冒烟测试：在 Windows 上解压 `dvalincode-v*-windows-x64.zip` 并从解压目录运行 `dvalincode-windows-x64.exe serve`。服务应打开 `http://localhost:3000`。若报出 `B:\~BUN\root\web\dist` 下的 `ENOENT` 路径，说明编译后的 Bun 虚拟路径检测退化了；打包后的二进制必须将 `web/dist` 解析到解压出的可执行文件旁边。

注意：Bun 仅在 Windows 上编译时才允许注入 Windows `.exe` 图标/元数据。macOS/Linux 交叉编译仍会产出有效的 Windows 压缩包，但不带内嵌的 `.exe` 图标。

构建桌面应用 —— 在装有 [Inno Setup 6](https://jrsoftware.org/isinfo.php) 的 Windows 主机上，同时构建安装包：

```sh
npm run build:gui:darwin    # macOS .app
npm run build:gui:windows   # Windows .exe + dvalincode-gui-v*-windows-x64-setup.exe
npm run icon:windows        # 从应用图标 SVG 重新生成 installer/windows/dvalincode.ico
```

安装包由 [`installer/windows/dvalincode.iss`](installer/windows/dvalincode.iss) 定义，只在 Windows 上编译 —— Inno Setup 本身就是 Windows 程序。在其他系统上 Windows 构建的其余步骤照常执行，安装包这一步会被跳过并给出提示。

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
| **CC Switch** | — | 取决于服务方 | `provider set cc-switch`：请求经 CC Switch 的本地路由（`127.0.0.1:15721`）转给它的 Codex 当前使用的服务商；key 由 CC Switch 保管 |

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
每次运行都向 <code>~/.dvalincode/audit/run-&lt;timestamp&gt;-&lt;id&gt;.jsonl</code> 写入 JSONL 审计日志。用 <code>dvalincode report --last</code> 渲染（或在 GUI 看可折叠的 Run Report 卡片）。每条记录都用 SHA-256 哈希与上一条相连，因此任何事后修改都可被检测 —— <code>dvalincode report verify &lt;run-id&gt;</code> 会报告 <code>✓ chain intact</code> 或断裂的确切位置。它是防篡改<b>可检测</b>，而非<b>不可篡改</b>：能重写整个文件的本地攻击者可重算整条链。其价值在于取证与可问责。完整威胁模型见 <a href="docs/AUDIT-TRAIL.md">docs/AUDIT-TRAIL.md</a>。
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

---

## 🤝 贡献

欢迎贡献！代码库保持紧凑、不堆叠 —— 详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```sh
git clone https://github.com/arthurpanhku/dvalincode
cd dvalincode && npm install
npm test                # 819/819 核心测试 ✅
npm run typecheck
```

---

## 📄 License

MIT —— 详见 [LICENSE](LICENSE)。

---

## 🔗 独立声明与致谢

DvalinCode 是一个独立实现的项目，与 Anthropic、Claude、Claude Code、
OpenAI、OpenAI Codex、GitHub、Cursor、Aider、opencode、Cline、
HKUDS/nanobot，或本节提到的任何其他项目/厂商不存在从属、赞助、背书或商业关联。

我们感谢公开研究、开源项目、论文、标准、release notes 和业界通用工作流共同塑造了
agentic coding 生态；DvalinCode 的产品方向和架构设计也受到了这些公开经验的启发：

- [HKUDS/nanobot](https://github.com/HKUDS/nanobot)（MIT）帮助验证了
  DvalinCode `TurnState` 流程中显式 turn-state 的设计方向。
- [ReAct 论文](https://arxiv.org/abs/2210.03629)（Yao et al., 2022）提出的
  “reason, act, observe” 循环，是许多现代工具调用型 Agent 的共同基础。
- OpenAI `tool_calls` 消息格式，以及更广泛的 OpenAI-compatible provider
  生态，为 DvalinCode 的模型/工具交互提供了可移植接口。
- OpenAI Codex / Codex CLI、Claude Code、Aider、opencode、Cursor、Cline
  等编码 Agent 帮助明确了用户对终端 Agent、plan/build 模式、权限提示、
  项目本地上下文、沙箱、session lifecycle、MCP 集成和 diff-first 编辑工作流的期待。
- [OpenAI Codex Security](https://github.com/openai/codex-security) 及其公开文档为
  Dvalin 的专业安全 Agent 研究和可移植 SARIF 交接提供了参考；Dvalin 仍是独立且参与
  竞争的安全运行时。
- `AGENTS.md` 项目指令约定在编码 Agent 工具中较常见，也影响了 DvalinCode
  加载项目本地指令的行为设计。
- CodeQL、GitHub Code Scanning、Semgrep、SARIF、OpenSSF Scorecard 与
  ISO/IEC 42001 影响了 DvalinCode 的安全修复闭环和 approvability 定位。
- Git worktree、MCP 与 local-first 开发者工具模式，影响了隔离修复、受治理工具
  访问和可审计执行等产品方向。

这些参考帮助我们理解用户对编码 Agent 的期待。除非明确标注，DvalinCode 的源代码、
prompt、UI 文案、工具 schema、模块布局和产品实现均为原创；未复制上述项目的
源代码、prompt 或 UI 文案。

完整来源参考：[docs/REFERENCES.md](docs/REFERENCES.md)

---

## 💛 感谢每一位贡献者

<p align="center">
  每一个 Issue、想法、文档改进、测试和代码贡献，都在帮助 DvalinCode 变得更好。
</p>

| 贡献者 | GitHub 主页 |
| --- | --- |
| Arthur Pan | [@arthurpanhku](https://github.com/arthurpanhku) |
| Shivas | [@shivasb42](https://github.com/shivasb42) |
| Aditya | [@adity982](https://github.com/adity982) |
| badhope | [@weed33834](https://github.com/weed33834) |
| Samran Asif | [@webdevsamran](https://github.com/webdevsamran) |
| dchaudhari7177 | [@dchaudhari7177](https://github.com/dchaudhari7177) |
| TayfurYldz | [@TayfurYldz](https://github.com/TayfurYldz) |

查看[完整贡献记录](https://github.com/arthurpanhku/dvalincode/graphs/contributors)，其中也包含自动依赖更新和维护记录。

<p align="center">
  <sub>也想加入？阅读<a href="CONTRIBUTING.md">贡献指南</a>，提交你的第一个 Pull Request。</sub>
</p>
