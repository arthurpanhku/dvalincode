---
layout: home

hero:
  name: DvalinCode
  text: 扫描器找问题，Agent 写修复，Dvalin 来判定
  tagline: 开源、供应商中立的安全修复裁判。Dvalin 用你 CI 本来就在跑的扫描器重新扫描、亲自跑你的测试、看退出码 —— 全部在你的机器上完成 —— 然后交给你一份任何人都能离线复验的记录。
  image:
    light: /logo-light.png
    dark: /logo-dark.png
    alt: DvalinCode
  actions:
    - theme: brand
      text: 30 秒试用
      link: '#install'
    - theme: alt
      text: 验证是怎么做的
      link: /spec/FIX-VERIFICATION
    - theme: alt
      text: GitHub
      link: https://github.com/arthurpanhku/dvalincode

features:
  - icon: ⚖️
    title: 判定里没有模型
    details: 依据是 Dvalin 自己启动的进程返回的退出码，以及与你 CI 门禁相同的引擎复扫的结果。它从不问修复方修得怎么样。
    link: /spec/FIX-VERIFICATION
    linkText: 开放规范
  - icon: 🥅
    title: 修复方没法挪球门
    details: 改动自己新增的忽略项在判定这次改动时不算数。在 CI 里，检查项、门禁和扫描器都取自基线提交，PR 没法放宽用来判它的规则。
    link: /zh/cli
    linkText: 和 CI 同一把尺子
  - icon: 🔇
    title: 让扫描器闭嘴不算修复
    details: 把 sink 换成同类写法、删掉有漏洞的文件、删测试或删断言，都判为不通过。对代码类 finding，测试必须在修复前失败、修复后原样通过。
    link: /zh/cli
    linkText: 修复循环
  - icon: 🔏
    title: 证明可以带走
    details: Verified Fix Record 用 <code>dvalin verify-fix</code> 离线就能复验，不需要工作区，也不需要联网。在 CI 里，runner 可以重新执行验证，并对观察到的结果签名。
    link: /zh/cli
    linkText: 重新执行并签名
  - icon: 🔓
    title: 开源，留在本地
    details: 得出判定的代码以 MIT 许可开源，并在本地运行。不需要账号、API Key 或任何厂商的云 —— fix record 和判定过程的日志都留在你手里。
    link: /zh/trust
    linkText: 信任与治理
  - icon: 🔌
    title: 供应商中立
    details: Claude Code、Codex、Cursor 等 MCP 客户端可以直接调用 Dvalin；Semgrep、Snyk、CodeQL、Trivy、OSV-Scanner、Codex Security 或任何 SARIF 生产者，都接入同一个门禁。判定本身完全不需要模型。
    link: /zh/cli
    linkText: 集成
---

## 它要终结的循环

扫描器拦下了你的 PR。你把 finding 交给编码 Agent，它的补丁回到 CI，又被扫描器拦下：
问题还在，补丁引入了新问题，或者 Agent 让扫描器闭了嘴，代码却没修好。于是有人一轮又
一轮地手动转述扫描结果、手动 rebase。

Dvalin 在这个循环里坐裁判席。它把还没解决的问题准确告诉修复方，每一轮都用 CI 的同一把
尺子来判，修复站得住才停。

## Dvalin 的位置

| | 找问题 | 写修复 | 判定修复是否成立 |
|---|:---:|:---:|:---:|
| **扫描器**：Semgrep、Snyk、CodeQL、Trivy、OSV-Scanner | ✓ | | |
| **编码 Agent**：Claude Code、Codex、Cursor、Copilot，或者人 | | ✓ | |
| **模型厂商的安全 Agent**：Codex Security、Claude Security | ✓ | ✓ | 在它们自己的产品里 |
| **Dvalin** | 调用你的扫描器 | 把活交给你的 Agent | ✓ 公开透明，在你的机器上 |

Dvalin 不是又一个扫描器，也不是又一个编码 Agent。它是两者之间的裁判，不管哪个 Agent
写的修复，判定标准都一样。内置规则让你什么都不装也能完成第一次扫描，内置 Agent 也可以
充当修复方，两者都是可选的。

模型厂商的安全 Agent 在一个产品里完成发现、修复和验证，依赖的是该厂商自己的模型和 API。
Dvalin 可以导入它们的发现，并像对待其他修复一样判定它们的修复。它自己的判定有三点不同：

- **开源。** 得出判定的代码以 MIT 许可开源，默认使用的扫描器也都是开源的。裁判用的每一条
  规则，你都能读、能自己跑、能 fork。
- **供应商中立。** 任何 Agent、任何扫描器、任何模型 provider 都行，也可以完全不用模型。
  得出判定不需要账号、不需要 API Key，也不需要任何厂商的云。
- **留存在本地。** 扫描结果、Dvalin 跑过的检查、fix record，以及记录判定过程的哈希链日志，
  都留在你的仓库和 `~/.dvalincode/` 里。默认情况下，判定不会把任何代码发出去；会上传源码
  的引擎（比如 Snyk Code）只有在你点名时才会运行。

## 30 秒试用 {#install}

```sh
npx dvalincode security scan .    # 不用安装，不用账号，不用 API Key
```

想长期使用，就安装 CLI，并运行完整的扫描器组合：

```sh
curl -fsSL https://raw.githubusercontent.com/arthurpanhku/dvalincode/main/scripts/install.sh | bash
dvalincode trust
dvalincode dvalin . --scanners builtin,semgrep,trivy,osv-scanner
```

这条 Dvalin 命令会运行内置规则，以及 `PATH` 中已安装的受支持开源引擎。
加上 `--fix --verify --record fix-record.json` 可以准备聚焦修复、运行测试，
并写出那份记录。这份记录可以直接交给任何人：

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

Windows 构建和各平台手动下载见
[Releases 页面](https://github.com/arthurpanhku/dvalincode/releases/latest)，
每个压缩包都附带 `SHA256SUMS.txt` 和构建来源证明（provenance attestation）。

## “verified”是什么意思，不是什么意思

这份记录刻意只说很窄的事：*这些 finding 原本存在；改动之后，复扫不再报告它们；这些命令
运行过，Dvalin 观察到了这些退出码。* 它没有说代码是安全的。每份记录都带着这次扫描的覆盖
范围（`complete`、`partial` 或 `unknown`）。没有任何检查能确认的修复不会通过 ——「没东西
可跑」不算通过；消除了一个 finding 却引入另一个的修复会记为 `regressed`。规避检测基于已知
模式，局限列在[诚实的差距](/SECURITY-AGENT-STRATEGY#honest-gaps-today)里（英文）。
[开放规范 →](/spec/FIX-VERIFICATION)

## 在你已有的工具里用

**在编码 Agent 里。** Dvalin 是一个 MCP server。把它接进这台机器上的 Agent（Claude Code、
Codex、Cursor、VS Code、Gemini CLI、OpenCode）：

```sh
npx dvalincode agents connect         # 预览每个 Agent 会得到什么
npx dvalincode agents connect --yes   # 执行
```

Agent 写完修复后调用 `dvalin_verify_findings`，就能拿回一份 Verified Fix Record。

**在每个 PR 上。** GitHub Action 不需要 API Key，也不需要模型：

```yaml
- uses: arthurpanhku/dvalincode@v0.24.0
  with:
    fail-on: high
    diff: true    # 只拦这个 PR 新增的问题
```

传入 `fix-record:`，runner 会复验这份记录，再把结果贴在 diff 旁边；签发之后被改过的记录
会在那里失败，并让整个 job 失败。加上 `reverify: true`，runner 会亲自重新执行一遍验证。

**在终端里。** 让 Dvalin 驱动修复方，直到门禁能够通过：

```sh
dvalincode dvalin . --until-clean --max-rounds 3 --executor codex
```

每一轮，Dvalin 都会重新扫描、运行你的检查，只把还没解决的问题发回给执行方。修复通过验证、
轮数用完或进展停滞时，循环停止；无论哪种结局，都会签发一份 fix record。
[CLI 指南 →](/zh/cli)

## 一次真实运行

![Dvalin 真实扫描与验证修复](/dvalin-remediation.gif)

上面的真实案例改编自 OWASP NodeGoat：三处 `eval` 调用改为受约束的数值解析并
新增一条注入回归测试后，从 10 条发现、22/F 变为 0 条、100/A。该分数是分诊
启发式，不是认证。

## 两个产品：CLI 和桌面应用

**[CLI](/zh/cli)** 面向终端与自动化，支持 macOS、Linux 和 Windows：`dvalin` 安全命令、
CI 门禁、无头运行，以及给你已有 Agent 用的 MCP server。它也包含 DvalinCode 的
[内置 Agent](/zh/agent)：直接运行 `dvalincode` 得到交互式终端 Agent，或者用
`dvalincode serve` 启动 Web GUI，供浏览器和远程使用。

**[桌面应用](/zh/gui)** 是放在独立窗口里的同一个引擎，支持 macOS 和 Windows：使用 Dvalin
安全工作区、和内置 Agent 对话、看它的 diff 并逐个审批改动，全程不需要终端。

![DvalinCode 网页界面](/hero.png)

### 验证证据一屏看清

Dvalin 面板把模型检查、项目测试报告、确定性复扫、扫描覆盖率、安全门禁和离线记录状态
放在一起。干净分数只是证据的一部分；advisory gate、缺失的 Fix Record 以及 Git 发布阻塞项
都会与结果同时展示。

![DvalinCode 验证证据面板：真实模型检查、确定性复扫通过、四引擎完整覆盖、advisory gate，以及明确列出的剩余限制](/dvalin-verify-local.jpg)

## 信任与治理

一份判定的分量，取决于签发它的运行时是否可信。组织策略划定 Dvalin 能做什么，每次运行都
以哈希链写入防篡改审计日志，没有被出网守卫放行的东西不会到达任何模型 provider。
[信任与治理 →](/zh/trust) · [威胁模型 →](/THREAT-MODEL)

## 代码签名政策

请阅读 [Code signing policy（代码签名政策）](/CODE-SIGNING) 和[隐私说明](/PRIVACY)。
正在准备 SignPath Foundation 免费 Windows 签名申请，尚未确认获批或启用正式签名。

## Dvalin 适合你吗？

**适合，如果……**

- 编码 Agent 正在修你扫描器报出的问题；
- 你用不止一个 Agent 或扫描器，想要一个统一的判定；
- 你必须向审计方证明某个修复真的有效；
- 判定必须公开透明、不依赖任何一家 AI 厂商，并且留在你自己的机器上。

**大概不适合，如果……**

- 你要找的是编码 Agent —— 用 Claude Code、Codex 或 opencode，再把 Dvalin 接进去；
- 你要的是最广的漏洞发现能力 —— 用专门的扫描器或 AI 安全 Agent；
- 你只用一个扫描器配它自家平台的自动修复，也没人要求你拿出证明。

> 📖 除 CLI、桌面应用、内置 Agent、信任与治理和新功能页面外，文档正文目前为英文。
