---
layout: home

hero:
  name: DvalinCode
  text: 每一次修复，都自带证明
  tagline: Agent 修好了一个安全问题之后，由 Dvalin 判断它到底修好没有 —— 重新扫描、亲自跑你的测试、读它自己启动的进程返回的退出码。修复是谁写的只被记录，绝不参与判定。
  image:
    light: /logo-light.png
    dark: /logo-dark.png
    alt: DvalinCode
  actions:
    - theme: brand
      text: 60 秒安装
      link: '#install'
    - theme: alt
      text: 验证是怎么做的
      link: /spec/FIX-VERIFICATION
    - theme: alt
      text: 为什么是"可审批"？
      link: /APPROVABILITY-PLAN
    - theme: alt
      text: GitHub
      link: https://github.com/arthurpanhku/dvalincode

features:
  - icon: 🔏
    title: 修复验证记录
    details: 修复由 Dvalin 验证，而不是由写下它的人验证。记录里有修复前后的目标、Dvalin 跑了哪些命令和它观察到的退出码，以及这次扫描究竟覆盖了什么 —— 用 dvalin verify-fix 可离线复验。
    link: /spec/FIX-VERIFICATION
    linkText: 开放规范
  - icon: 🔍
    title: 看得懂的覆盖率
    details: 每次扫描都报告 complete / partial / unknown。基线里的 finding 如果对应引擎这次根本没跑，会被报成 unknown 而不是 resolved —— 「没去看」不等于「已修好」。
    link: /DVALIN
    linkText: 扫描语义
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
    title: 任意 Agent 或安全证据源
    details: Codex Security、CodeQL、GitHub Code Scanning、Semgrep、Trivy、OSV-Scanner 或其他 SARIF 生产者，都可以把证据交给同一个本地 Dvalin 门禁。
    link: /DVALIN
    linkText: 互操作
  - icon: 💻
    title: 本地优先的零依赖二进制
    details: 每个平台一个约 25 MB 的可执行文件。不需要 Node、Python 或 Docker。会话、配置和审计日志都留在你机器的 ~/.dvalincode 下。
---

## 别人没在回答的那个问题

所有人都在卷「**发现**漏洞」和「**修**漏洞」。几乎没有人在回答下一个问题：
**你怎么知道这个修复是真的修好了？**

在大多数工具里，这个答案来自写下修复的那个模型 —— 直接问它，或者去解析它对自己
做了什么的自述。而这恰恰是模型最无法违背自身利益去诚实回答的问题，改多少遍
prompt 都没用。

Dvalin 把这个判断权从修复者手里彻底拿走：

| | |
|---|---|
| **谁改代码** | 任何 agent，或者人。只作为元数据记录。 |
| **谁判断修好没有** | Dvalin：它重新扫描，并亲自跑你项目自己的检查。 |
| **判定依据是什么** | Dvalin 自己启动的进程返回的退出码。绝不是别人递过来的报告。 |
| **你拿到什么** | 一份任何人都能离线复验的记录，不需要工作区，也不需要联网。 |

**没有任何检查能确认的修复，不会通过** —— 「没东西可跑」不算通过。而且每份记录都
带着这次扫描实际覆盖了什么，所以半数引擎缺失时的「没发现问题」，永远不会读起来像
一次完整扫描的结论。[开放规范 →](/spec/FIX-VERIFICATION)

## 60 秒安装并运行 Dvalin {#install}

不必凭口头信任——在你自己的机器上验证：

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
  ✓ test: npm run test (exit 0)
  audit: run verify-36509f42 @ 414644c75af0
```

同样的检查也能跑在 PR 上 —— 给 GitHub Action 传 `fix-record:`，它会在 runner 上
重新推导这份记录，然后把结果贴在 diff 旁边。签发之后被改过的记录会在那里失败，
并让整个 job 失败。

![Dvalin 真实扫描与验证修复](/dvalin-remediation.gif)

上面的真实案例改编自 OWASP NodeGoat：三处 `eval` 调用改为受约束的数值解析并
新增一条注入回归测试后，从 10 条发现、22/F 变为 0 条、100/A。该分数是分诊
启发式，不是认证。

Dvalin 将 MIT 许可的 DvalinCode 流水线与开源
[Semgrep CE](https://github.com/semgrep/semgrep)、
[Trivy](https://github.com/aquasecurity/trivy)、
[OSV-Scanner](https://github.com/google/osv-scanner) 和 SARIF 2.1 互操作结合起来。
扫描证据指导配置的模型；DvalinCode 记录 diff、运行项目测试、复扫，并要求用户
显式发布 PR。
Codex Security 等专业 Agent 也可以把 SARIF 导入同一个 case 和门禁流程，
而 Dvalin 不接管它们的凭据或密封扫描工件。Dvalin 也可以独立完成发现、修复和
验证闭环；互操作是一种选择，不是产品边界。

代理完成工作后仍可事后证明它做过什么：

```sh
dvalincode report verify    # 重新推导上次运行审计日志的哈希链
```

Windows 构建和各平台手动下载见
[Releases 页面](https://github.com/arthurpanhku/dvalincode/releases/latest)，
每个压缩包都附带 `SHA256SUMS.txt` 和构建来源证明（provenance attestation）。

## 一个二进制，三种前端

直接运行 `dvalincode` 得到交互式**终端代理**——流式输出、行内审批、红绿 diff；
或者 `dvalincode serve` 启动**网页 GUI** 供浏览器和远程使用。实验性的**桌面应用**
在独立的预发布轨道上发布。三者驱动同一个代理内核。

![DvalinCode 网页界面](/hero.png)

## 为需要独立安全结论的团队而造

DvalinCode 是一个 **Agent 可调用的安全运行时**：它可以独立运行、在安全发现和修复
领域参与竞争，也可以与专业系统互操作；但它不以替代所有通用 Coding Agent 为目标。
产品本身是人类或 Agent 代码合并前，安全、合规或平台团队所需要的发现、证据、修复
与强制执行层：

- **可控** —— [组织策略](/POLICY-REFERENCE)限定影响范围。
- **透明** —— `dvalincode trust` 让安全态势可自证。
- **可审计** —— [哈希链日志](/AUDIT-TRAIL)证明每次运行做了什么。

建议从[威胁模型](/THREAT-MODEL)读起，了解完整攻击面——恶意 `AGENTS.md`、被投毒的
MCP 服务器、提示注入升级、数据外流、审计篡改——每一项都对应到防御它的控制措施，
以及诚实标注的残余风险。

## DvalinCode 适合你吗？

诚实的适配判断——我们比拼的是可衡量的安全结果和“可审批”，而不是包打天下。

**选择 DvalinCode，当……**

- 安全或合规评审挡在团队与 AI 编码之间——你需要的是**证据**（策略哈希、可验证的审计链、可导出的 Evidence Pack），而不是厂商的口头承诺。
- 边界必须由组织、而非每个开发者来设定：允许哪些命令、路径、模型、MCP 服务器、网络出口。
- 你需要模型自由或完全离线运行（本地模型、任何 OpenAI 兼容端点），数据留在自己机器上。

**另寻他处，当……**

- 你只想要最强的通用编码自动驾驶、治理不是约束——今天 Claude Code 或 Codex 会更适合你。
- 你想要 IDE 内的代码补全——那是 Copilot/Cursor 的领域；DvalinCode 是终端/网页代理运行时。

> 📖 文档正文目前为英文。
