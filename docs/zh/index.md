---
layout: home

hero:
  name: DvalinCode
  text: 面向受监管团队的可审批编码代理
  tagline: 任意模型 · 本地优先 · 策略约束 · 审计就绪 —— 一个安全团队真正敢批准的 AI 编码代理。
  image:
    light: /logo-light.png
    dark: /logo-dark.png
    alt: DvalinCode
  actions:
    - theme: brand
      text: 60 秒安装
      link: '#install'
    - theme: alt
      text: 为什么是"可审批"？
      link: /APPROVABILITY-PLAN
    - theme: alt
      text: GitHub
      link: https://github.com/arthurpanhku/dvalincode

features:
  - icon: 🔒
    title: 组织策略约束代理
    details: 由公司——而不是开发者——通过 dvalin.policy.json 限定模式、shell 命令、文件路径、工具和模型。仓库策略只能收紧机器策略，永远不能放宽。
    link: /POLICY-REFERENCE
    linkText: 策略参考
  - icon: 🛡️
    title: 防篡改审计日志
    details: 每次运行都产出哈希链式 JSONL 日志——每次文件读写、每条命令、每个审批。用 dvalincode report verify 离线校验完整性。
    link: /AUDIT-TRAIL
    linkText: 威胁模型
  - icon: 🏛️
    title: 证据，而非口头承诺
    details: OpenSSF Scorecard、CodeQL、固定版本的 Actions、ISO/IEC 42001 对齐文档，以及可离线验证的证据包——全部作为可审查的项目工件维护。
    link: /EVIDENCE-PACK
    linkText: 证据包
  - icon: 🔑
    title: 任意模型，无锁定
    details: DeepSeek、OpenAI、Claude（经 OpenRouter）、Groq、Ollama，或任何 OpenAI 兼容端点。一键切换，也可用本地模型完全离线运行。
  - icon: 💻
    title: 本地优先的零依赖二进制
    details: 每个平台一个约 25 MB 的可执行文件。不需要 Node、Python 或 Docker。会话、配置和审计日志都留在你机器的 ~/.dvalincode 下。
  - icon: 🧰
    title: 内置安全修复工作流
    details: 本地扫描，或从 CodeQL、GitHub Code Scanning、Semgrep 导入 SARIF——发现项变成隔离的修复工作树，并生成可直接提 PR 的报告。
    link: /SECURE-REMEDIATION
    linkText: 工作流
---

## 60 秒安装 {#install}

不必凭口头信任——在你自己的机器上验证：

```sh
curl -fsSL https://raw.githubusercontent.com/arthurpanhku/dvalincode/main/scripts/install.sh | bash
dvalincode trust
```

`trust` 会打印这份安装的**实时安全态势**：生效的组织策略及其哈希、按边界的网络管控（provider · shell · MCP）、以及防篡改审计状态——正是安全评审需要的证据，由工具本身直接给出。

![dvalincode trust —— 组织策略下的实时安全态势](/cli-trust.gif)

让代理干完活之后，还能事后证明它做了什么：

```sh
dvalincode report verify    # 重新推导上次运行审计日志的哈希链
```

![dvalincode report verify —— 防篡改审计链与运行报告](/cli-audit.gif)

Windows 构建和各平台手动下载见
[Releases 页面](https://github.com/arthurpanhku/dvalincode/releases/latest)，
每个压缩包都附带 `SHA256SUMS.txt` 和构建来源证明（provenance attestation）。

## 一个二进制，三种前端

直接运行 `dvalincode` 得到交互式**终端代理**——流式输出、行内审批、红绿 diff；
或者 `dvalincode serve` 启动**网页 GUI** 供浏览器和远程使用。实验性的**桌面应用**
在独立的预发布轨道上发布。三者驱动同一个代理内核。

![DvalinCode 网页界面](/hero.png)

## 为需要安全团队点头的场景而造

DvalinCode 是一个**可审批的代理运行时**，不只是又一个编码代理。产品本身就是
安全、合规或平台团队放行 AI 编码所需要的证据，适用于金融、医疗和其他机密代码库：

- **可控** —— [组织策略](/POLICY-REFERENCE)限定影响范围。
- **透明** —— `dvalincode trust` 让安全态势可自证。
- **可审计** —— [哈希链日志](/AUDIT-TRAIL)证明每次运行做了什么。

建议从[威胁模型](/THREAT-MODEL)读起，了解完整攻击面——恶意 `AGENTS.md`、被投毒的
MCP 服务器、提示注入升级、数据外流、审计篡改——每一项都对应到防御它的控制措施，
以及诚实标注的残余风险。

## DvalinCode 适合你吗？

诚实的适配判断——我们比拼的是"可审批"，而不是包打天下。

**选择 DvalinCode，当……**

- 安全或合规评审挡在团队与 AI 编码之间——你需要的是**证据**（策略哈希、可验证的审计链、可导出的 Evidence Pack），而不是厂商的口头承诺。
- 边界必须由组织、而非每个开发者来设定：允许哪些命令、路径、模型、MCP 服务器、网络出口。
- 你需要模型自由或完全离线运行（本地模型、任何 OpenAI 兼容端点），数据留在自己机器上。

**另寻他处，当……**

- 你只想要最强的通用编码自动驾驶、治理不是约束——今天 Claude Code 或 Codex 会更适合你。
- 你想要 IDE 内的代码补全——那是 Copilot/Cursor 的领域；DvalinCode 是终端/网页代理运行时。

> 📖 文档正文目前为英文。
