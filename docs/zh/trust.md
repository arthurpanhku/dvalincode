# 信任与治理

[English](../trust.md) · **中文**

一份判定的分量，取决于签发它的运行时是否可信。本页汇集安全评审核查 Dvalin 本身所需的
材料：由组织、而不是开发者本人来划定它能做什么；每次运行都以哈希链写入防篡改审计日志；
没有被出网守卫放行的东西不会到达任何模型 provider。仓库级策略只能**收紧**机器级策略，
永远不能放宽。

如果你正是那个需要审批这类工具的人，请从
[可审批性方案](../APPROVABILITY-PLAN.md)和每个版本随包发布的
[Evidence Pack](../EVIDENCE-PACK.md) 开始看（英文）。

## 可控、透明、可审计

治理是内建的，而非事后附加：组织级策略约束影响面（**可控**），`dvalincode trust` 让安全
态势可自证（**透明**），哈希链日志证明每次运行做了什么（**可审计**）。这三者正是安全评审
说“yes”所需要的。

- **组织级策略 & `trust`** —— 由公司、而非开发者来约束 Agent。一个 `dvalin.policy.json`
  限定模式、shell 命令、文件路径、工具与模型；仓库级策略只能让机器级策略*更严*、永不放宽。
  每次运行都记录所遵循策略的哈希。`dvalincode trust` 直接打印本机的实时安全态势 —— 生效
  策略 + 哈希、审计状态、运行时 —— 让审批人自行核验。[策略参考 →](../POLICY-REFERENCE.md)
- **审计日志** —— 每次运行都生成防篡改、哈希链式的 JSONL 日志：每次文件读写、每条命令、
  每次审批都被记录。Run Report 将其渲染为 Markdown，`dvalincode report verify` 可验证链条
  完好。[审计日志 →](../AUDIT-TRAIL.md)
- **开放规范** —— **PCP-1** 把模型提供方边界的约束（出网收敛、凭据收敛、审计、策略绑定）
  写成与厂商无关、带测试步骤的开放规范，任何 agent 运行时都可以拿它跑自己的 adapter 并公开
  结果：这也是别人同样可以用来衡量我们的清单。
  [Provider Conformance Profile →](../spec/PROVIDER-CONFORMANCE.md) ·
  [Fix Verification Profile（FVP-1）→](../spec/FIX-VERIFICATION.md)

事后仍可证明 agent 做过什么：

```sh
dvalincode report verify    # 重新推导上次运行审计日志的哈希链
```

## 给安全评审的证据

DvalinCode 维护项目级治理证据，便于开源用户和企业安全评审：

- **威胁模型** —— 覆盖 agentic coding runtime 的完整攻击面（恶意 `AGENTS.md`、被投毒的
  MCP server、prompt-injection 提权、egress、审计篡改、供应链、沙箱逃逸），并将每个风险
  映射到防护控制和诚实的剩余缺口。[威胁模型 →](../THREAT-MODEL.md)
- **OpenSSF Scorecard 支持** —— 定时 Scorecard workflow、SARIF 上传、CodeQL、Dependabot、
  CODEOWNERS、最小权限 workflow permissions，以及固定 SHA 的 GitHub Actions。
  [控制映射 →](../security/OPENSSF-SCORECARD.md)
- **ISO/IEC 42001 对齐** —— AI 管理体系范围、AI policy、角色映射、风险登记、AI 变更分级、
  必留记录和审查节奏。[AIMS 对齐 →](../governance/ISO-42001-AIMS.md)
- **AI 变更影响评估** —— 面向模型/provider 行为、prompt、权限、工具、审计日志或发布安全
  变更的可复用模板。[模板 →](../governance/AI-CHANGE-IMPACT-ASSESSMENT.md)
- **发布证据** —— 每个 release 都附带一份由该二进制给自己生成的 Evidence Pack。
  [发布证据 →](../RELEASE-EVIDENCE.md)
- **高合规使用姿态** —— 本地优先的数据处理、策略约束的自主性、最小化审计记录，以及面向
  金融、医疗、安全敏感 SaaS 和企业内部使用的发布供应链证据。

这些文档是实现证据和运行流程，不代表项目已经获得第三方 ISO 认证。
