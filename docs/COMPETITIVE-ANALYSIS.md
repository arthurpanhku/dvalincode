# 竞品对比与下一步开发抓手

> 日期：2026-08-25 · 对照版本：DvalinCode v0.18.0
> 本文是一份**分析报告**，不是已立项的开发计划。结论章节（§3）给出的设计与分期
> 供后续立项讨论使用。

> **状态更新（2026-09-03）：本文推荐的主抓手 B 已立项并交付。**
> §4.2 的 Phase 0–2 全部落地，`docs/spec/FIX-VERIFICATION.md`（FVP-1）已作为
> 厂商中立规范发布。§3、§4 因此应当作**已执行方案的记录**来读，而不是待议提案；
> 各阶段的实际落点见 §4.2 的行内标注。
>
> 仍未做的只有 Phase 3（公开 TypeScript SDK）与 §4.3 的 `FEATURE_GAP.md` 归档标注。
>
> §2 的竞品对比是 2026-08 的时点快照，未随本次更新重新调研——引用时请注意时效。

## 摘要

DvalinCode 已从「对标 Codex CLI 的编码 agent」彻底转向「独立安全运行时 + 可审批性」。
把当前实现与市面成熟商业/开源产品对齐后，只剩一个位置是竞争对手**结构上**做不到的：

> 所有人都在卷「**发现**漏洞」和「**修**漏洞」。
> 没有人在做「**证明这个修复是真的**」——因为在他们的架构里，
> **提出修复的模型和判断修复的模型是同一个**。

Dvalin 已经实现了这个能力（`src/remediation/verify.ts`：由 Dvalin 自己跑项目的
test/typecheck/build，判定依据是**观察到的退出码**而非执行器自述），但它今天只是
`SecurityWorkflow.verification` 里的一个内部字段——没有名字、不可移植、不能离线复验、
PR 上看不到、别的 agent 调不到。

**建议的下一步抓手：把它提升为一等公民产物 —— Verified Fix Record（VFR）。**

> **已执行（2026-09）。** 上面那五个「没有」现在一个都不成立：记录有名字、有规范
> （FVP-1）、可用 `dvalin verify-fix` 离线重算、由 GitHub Action 贴在 PR 上、
> 别的 agent 可通过 `dvalin_verify_fix` MCP 工具索取。下文保留原始判断不改写，
> 以便对照当时的推理与实际结果。

---

## 1. 当前计划的结构性错配（已消解）

项目有两条并行战略主线：

| 主线 | 文档 | 写作时状态（2026-08-25） | 现状（2026-09-03） |
|---|---|---|---|
| 可审批性（policy / audit / evidence） | `docs/APPROVABILITY-PLAN.md` | P0–P2 基本交付，剩 A5 服务端强制、[#53](https://github.com/arthurpanhku/dvalincode/issues/53) 结构化授权 | 不变 |
| 安全扫描竞争力 | `docs/SECURITY-AGENT-STRATEGY.md` | 自评 P0「可信扫描语义」**未做**，P1 SDK / 深度发现**未做** | **P0 已交付**（coverage 三态 + reopened/dismissed 全生命周期，`SECURITY_SCHEMA_VERSION = 2`）；P1 的 agent 独立验证钩子随 `dvalin_verify_fix` 交付，SDK 与深度发现仍未做 |

**本节当时的判断是：第二条主线自己文档里标为 P0 的三项一条都没进排期，这是最大的结构性错配。**
该错配已经消解——不是被搁置，而是被执行：VFR 立为主线并落地，P0 的可信扫描语义作为它的地基先行交付
（§4.2 Phase 0）。

`ROADMAP.md` 的 Now/Next 也随之改写，不再全部落在第一条主线：

| 条目 | 主线 | Ref |
|---|---|---|
| Distribution + live conformance | 安全扫描 / 分发 | [integrations/](https://github.com/arthurpanhku/dvalincode/tree/main/integrations) |
| Fix-verification adoption（转向激活度量） | 安全扫描 / 证据 | [FVP-1](https://github.com/arthurpanhku/dvalincode/blob/main/docs/spec/FIX-VERIFICATION.md) |
| provider 一致性套件 | 可审批性 | [#118](https://github.com/arthurpanhku/dvalincode/issues/118) |
| 结构化授权 | 可审批性 | [#53](https://github.com/arthurpanhku/dvalincode/issues/53) |
| harness / unattended 测试 | 可审批性 | [#119](https://github.com/arthurpanhku/dvalincode/issues/119) |
| Explore 子代理 · worktree 治理 · MCP 发现审计 | 可审批性（Next） | [#54](https://github.com/arthurpanhku/dvalincode/issues/54) · [#55](https://github.com/arthurpanhku/dvalincode/issues/55) · [#56](https://github.com/arthurpanhku/dvalincode/issues/56) |

README 首屏也已改写，从「我们也能扫」换成本文 §3 推荐的叙事：
「Every repair carries its own proof.」

> 附带：`requirements/FEATURE_GAP.md` 对标的是 v0.3 时代的 Codex CLI 功能表，
> 已落后两个大版本，建议标注归档以免误导后续规划。
> **仍未处理** —— 该文件目前最新的复核标记仍是 2026-06-10 对照 v0.3.0。

---

## 2. 市面竞品对比（2026-08）

### 2.1 安全扫描 / 修复赛道

| 类型 | 代表 | 打法 | 对 Dvalin 的意义 |
|---|---|---|---|
| **AI-native SAST** | ZeroPath、Corgea、Aikido、BlackDuck、AISLE、Depthfirst | 推理模型直接作为检测引擎，无底层规则引擎；跨文件数据流、认证边界、业务逻辑判断。ZeroPath 宣称误报降 75% | Dvalin 内置规则只有 **7 条**（`src/remediation/localScan.ts`：hardcoded-secret / aws-access-key / sql-string-concatenation / nosql-injection / dom-html-injection / eval / shell-command-injection）。**检出广度上不可能追上，也不该追** |
| **AI-assisted SAST** | Semgrep + AI、Snyk（DeepCode AI Fix 自称约 80% 修复准确率）、GitHub Copilot Autofix（修复提速约 3×，SQL 注入类最高约 12×） | 保留确定性引擎做检测，AI 只做分诊 / 语言覆盖扩展 / 修复 | Dvalin 架构属同类，但规则肌肉是借来的（Semgrep CE / Trivy / OSV-Scanner） |
| **可达性分析** | Endor Labs | 用可达性解决误报疲劳 | Dvalin 无可达性分析。`--diff` 是不同角度的替代（回答「这次改动引入了什么」而非「这个仓库有什么」） |
| **同形态直接竞品** | **OpenAI Codex Security**（Apache-2.0，CLI + TypeScript SDK） | 2026-03 研究预览，现已开源。`coverage.json` 记录 reviewed surfaces、exclusions、deferred areas、open questions，以及 complete / partial / unknown 三态 | **定位高度重叠且已开源**。Dvalin 缺其中两项：coverage 契约、公开 SDK |

### 2.2 Agent 治理赛道

| 代表 | 打法 | 对 Dvalin 的意义 |
|---|---|---|
| Bifrost（Maxim AI，Go，开源）、Obot Enterprise MCP Gateway、MintMCP | MCP / Agent 网关：集中认证（OAuth 2.x / SSO）+ 身份绑定审计 + DLP / guardrails 中间件，统一治理 Claude、Cursor、ChatGPT、Gemini、Copilot 的工具调用 | 他们正在抢 `APPROVABILITY-PLAN.md` 的 **A5 服务端强制 + 中央审计聚合**。网关形态天然多租户、易售卖；Dvalin 以单机二进制正面打这条线是逆风 |
| 监管环境 | **EU AI Act 高风险义务 2026-08-02 生效**：AI 清单、技术文档、交互留痕、人工监督 | 对 Dvalin 的 hash-chain 审计 + Evidence Pack 是顺风，但顺的是「**留痕与证据**」，不是「网关」 |

### 2.3 三方对齐后的空位

把两个赛道叠在一起看：

- 检测广度 → AI-native SAST 已占据，且靠模型规模持续拉开。
- 修复速度 → Copilot Autofix / Snyk 靠平台位置占据。
- 集中治理 → MCP 网关厂商占据，且形态更适合企业采购。
- **修复的独立证明 → 空的。**

空在这里不是偶然。对 AI-native SAST 和 Copilot Autofix 而言，**提出修复的模型和
判断修复是否成立的模型是同一个**；它们的证据又封存在各自云端、可变、不可离线复验。
这是架构决定的，不是他们没想到。

Dvalin 恰好三样都占：
1. `src/remediation/verify.ts` —— Dvalin 自己执行项目检查，判定依据是**观察到的退出码**。
   注释写得很清楚：问刚写完补丁的 agent 它的补丁好不好，是它最无法诚实回答的问题。
   这也是为什么 `--executor dvalin|codex` 的选择只关乎成本与质量，**不关乎信任**。
2. `src/security/contracts.ts` 的 `targetFingerprint` —— 保守的重扫键，同规则同文件即使
   位置移动仍算目标未消除。
3. `src/audit/hash.ts` + `src/evidence/pack.ts` —— hash 链与 `bundleHash`，可离线复验。

**零件齐了。缺的只是把它们组装成一个有名字的产物，并且暴露出去。**

---

## 3. 抓手评估与推荐

| 抓手 | 差异化 | 成本 | 判断 |
|---|---|---|---|
| **A. 扫描语义诚实化**（coverage complete/partial/unknown + 完整生命周期 reopened/dismissed/unknown） | 低（补齐 Codex Security 已有的） | 小 | **必做，但只是地基**。没有覆盖率语义，任何「已验证」的声明都是过度声明 —— ✅ 已交付 |
| **B. Verified Fix Record（VFR）** —— 把 `verification` 提升为可移植、可离线复验的一等产物 | **极高，唯一** | 中 | **推荐主抓手** —— ✅ 已交付，见 FVP-1 |
| C. 公开 TypeScript SDK | 低（追平 Codex Security） | 中 | 随 B 顺带产出（Record 本身即契约），不单独立项 —— ❌ 未做，是本方案唯一未兑现的一期 |
| D. AI-native 检测引擎（追 ZeroPath / Corgea） | 负（正面硬碰己方最弱项） | 极大 | **建议明确不做**，写入 Non-goals |
| E. 治理控制平面（A5 / #53 / #118） | 中（但 MCP 网关正在抢） | 大 | 保留在 Roadmap，不作为主抓手 |

### 为什么是 B

1. **建立在已有代码上，不是重写。** `verify.ts`、`workflow.ts` 的 `verification.assurance`、
   `contracts.ts` 的 `targetFingerprint`、`audit/hash.ts` 的链、`evidence/pack.ts` 的
   `bundleHash` 都已存在且可复用。
2. **与 Dvalin 最弱处解耦。** Dvalin 的内置检测规则弱、自研 agent 的修复质量比不过大厂。
   但「验证别人的修复」既不需要 Dvalin 会检测，也不需要 Dvalin 会修 ——
   Claude Code 修的、Codex 修的、Copilot Autofix 修的，Dvalin 都能当**公证人**。
   这把产品价值从「我的模型有多强」解耦到「我的证据有多硬」，而后者正是 Dvalin 的强项。
3. **分发渠道现成。** MCP server（已实测接入 Claude Code 2.1.226、Codex 0.147.0、Cursor、VS Code）、
   GitHub Action（已上架 Marketplace）、SARIF、Evidence Pack —— 四个出口全部已建成。
4. **监管顺风。** EU AI Act 2026-08-02 生效的「交互留痕 + 人工监督记录」，
   一份可离线复验的修复证明正好对口。
5. **叙事干净。** 一句话说得清：
   *「别的工具告诉你它修好了；Dvalin 给你一张任何人都能自己重算的证明。」*

---

## 4. Verified Fix Record 设计（结论章节，未立项）

### 4.1 定义

一份 JSON 产物，记录一次「修复被独立验证」的完整因果链，**任何第三方可离线重算**：

```
修复前扫描（scanId + findings 指纹集 + coverage 三态）
  → 改动（diff hash + 变更文件列表）
  → 谁改的（executor: dvalin | codex | claude-code | copilot | human | unknown）
  → Dvalin 自己跑的项目检查（命令 + 观察到的退出码，非自述）
  → 目标指纹重扫结果（该 targetFingerprint 是否消失）
  → 新增回归测试（有 / 无）
  → 审计链锚点（runId + audit head hash）
  → 整体 recordHash
```

三条关键性质：

- **执行器中立** —— `executor` 只是元数据，不参与判定。Dvalin 从不询问执行器
  它自己修得好不好。
- **不过度声明** —— 记录必须携带 coverage 三态与 `assurance` 等级；
  跑不出任何项目检查的项目**判失败**而非默认通过（现有 `verify.ts` 已是此语义：
  "an unverifiable fix is not a verified one"）。
- **可离线复验** —— `dvalin verify-fix <record.json>` 能在另一台机器上重算哈希、
  重跑重扫，CI 友好退出码。

### 4.2 分期建议

**Phase 0 — 地基：诚实的扫描语义**（必须先行，否则 VFR 在过度声明）✅ **已交付**

> 落点：`src/security/contracts.ts` 的 `SECURITY_SCHEMA_VERSION = 2`、
> `SECURITY_COVERAGE_STATUSES = ['complete','partial','unknown']`、
> `SecurityFindingDelta` 的 `reopened` / `dismissed`。旧版 schema 通过
> `SUPPORTED_SECURITY_SCHEMA_VERSIONS = [1, 2]` 兼容，§5 提到的迁移风险按此处理。

- `src/security/contracts.ts`：`SECURITY_SCHEMA_VERSION` → 2；新增
  `SecurityCoverage = { status: 'complete' | 'partial' | 'unknown', scannedPaths, exclusions, deferred, notes }`；
  `SecurityFindingDelta` 从 new/existing/resolved 扩展出 `reopened` / `dismissed` / `unknown`。
- `src/remediation/scannerSuite.ts`：把已有的 per-scanner `status: completed|missing|error`
  与 `skippedResults` 聚合成 suite 级 coverage（任一 scanner missing/error → partial；
  被 `.dvalincodeignore` 或 policy 拦下的路径 → 记入 exclusions）。
- `src/security/workflow.ts`：baseline 比对时区分 reopened（曾 resolved 又出现）与
  dismissed（存在 suppression）。
- 复用：`src/security/suppressions.ts`（已有 reason / owner / expiry）、`src/core/ignorefile.ts`。

**Phase 1 — VFR 核心** ✅ **已交付**

> 落点：`src/security/fixRecord.ts`（`verifyFixRecord`）、`fixRecordFile.ts`、
> `fixRecordStore.ts`。哈希如建议沿用 `src/audit/hash.ts` 的 `sha256` + canonical JSON。

- 新增 `src/security/fixRecord.ts`：`buildFixRecord()` / `verifyFixRecord()` /
  `FIX_RECORD_SCHEMA = 'dvalin-fix-record/v1'`。哈希沿用 `src/audit/hash.ts` 的
  `sha256` + `canonicalJSON`（与 Evidence Pack 同一套，不另起炉灶）。
- `src/security/workflow.ts`：`verification` 升级为引用 VFR，保留旧字段做向后兼容。
- `src/commands/security.ts`：`dvalin verify <workflow-id> --record <file>` 输出 VFR；
  新增 `dvalin verify-fix <record.json>` 离线复验，沿用 `src/core/exitCodes.ts` 的
  `EXIT.gateNotMet`（5）。
- `src/commands/dvalin.ts`：`--fix --verify` 结束时自动写出 VFR。

**Phase 2 — 四个出口全部曝光**（价值兑现在这一步，不能省）✅ **已交付**

> 落点：`src/mcp/server.ts` 的 `dvalin_verify_fix`（§4.2 点名「最重要的一个出口」）、
> `action.yml` 的 `fix-record` 输入与 `fix-record-verified` / `fix-record-hash` 输出、
> `src/evidence/pack.ts` 的 `fixRecords` 一节、`docs/spec/FIX-VERIFICATION.md`（FVP-1）。
> Action 在 runner 上仅凭文件重算哈希并重新推导判定，被改过的记录会让该 job 失败——
> 审阅者因此不需要信任产出它的流水线。

- `src/mcp/server.ts`：新增 `dvalin_verify_fix` 工具 —— 让 Claude Code / Codex / Cursor
  在自己改完代码后主动向 Dvalin 索取一份独立验证证明。**这是最重要的一个出口。**
  （当前 9 个工具包括只读 `dvalin_scan`、显式落盘的
  `dvalin_begin_verification`、`dvalin_verify_fix`，以及 run/session/evidence/
  finding/verification/scanner 工具。）
- `action.yml`：VFR 作为 action output + artifact + PR sticky comment 的一节
  （复用现有 `comment: 'true'` 通路）。
- `src/evidence/pack.ts`：VFR 收入 Evidence Pack 的 `manifest.sections`。
- 新增 `docs/spec/FIX-VERIFICATION.md`：比照 `docs/spec/PROVIDER-CONFORMANCE.md`（PCP-1）
  的写法做成**厂商中立的开放规范**，任何 agent runtime 都能实现并自证。
  PCP-1 已经验证过这个打法有效。
- `README.md` / `README.zh-CN.md`：首屏叙事从「我们也能扫」改成「我们给修复出证明」。

**Phase 3 — 顺带产出** ❌ **未做**

`src/security/contracts.ts` + `fixRecord.ts` 的类型即 SDK 表面，补一个 `sdk` 导出入口
即可回应 `SECURITY-AGENT-STRATEGY.md` P1 的「public TypeScript SDK」。

> 现状：`package.json` 没有对外的 `exports` 入口，类型只能从内部路径引用。
> 这是本方案唯一未兑现的一期，且前三期已把契约稳定下来，成本比写作时更低。

### 4.3 配套的零代码动作

- ✅ `ROADMAP.md`：把 `SECURITY-AGENT-STRATEGY.md` 的 P0 提进 Now/Next，VFR 立为主线。
  —— 已完成；North Star 下方现在直接写着「every repair carries its own proof」并指向 FVP-1。
- ❌ `requirements/FEATURE_GAP.md`：标注归档（对标 v0.3 时代 Codex CLI，已过期两个大版本）。
  —— **仍未做**。
- ✅ Non-goals 增加一条：**不做 AI-native 检测引擎**，Dvalin 是引擎中立的编排 + 验证层。
  —— 已写入 `ROADMAP.md` Non-goals。

---

## 5. 风险

- **过度声明是最大风险。** VFR 若被读成「这段代码安全了」会直接砸掉招牌。
  规范文档必须开宗明义写死：VFR 证明的是「**这个 finding 在这次改动后，
  按这些被观察到的检查消失了**」，**不是**「代码无漏洞」。
  这也正是 Phase 0 必须先行的原因 —— 没有 coverage 三态，就没有资格谈证明。
- Phase 0 变更 `SECURITY_SCHEMA_VERSION`，需处理已有 baseline / workflow 文件的迁移。
- Phase 2 的 MCP 工具是价值兑现点。若只做到 Phase 1，等于把证明造出来锁在抽屉里，
  不要中途停。

---

## 6. 来源

本仓库现状的每条断言均可指向具体文件（见正文行内引用）。竞品侧结论来自以下公开资料：

- [openai/codex-security](https://github.com/openai/codex-security) ·
  [npm @openai/codex-security](https://www.npmjs.com/package/@openai/codex-security)
  —— Apache-2.0、TypeScript SDK、`coverage.json` 的 complete/partial/unknown
- [Best AI Code Security Tools in 2026 (Corgea)](https://corgea.com/learn/best-ai-code-security-tools)
  —— AI-native 与 AI-assisted SAST 的分野
- [Snyk Alternatives (ZeroPath)](https://zeropath.com/articles/snyk-alternatives) ·
  [Top 10 AI SAST tools in 2026 (Aikido)](https://www.aikido.dev/blog/top-10-ai-powered-sast-tools-in-2025)
- [Best AI Code Security Tools 2026 — Snyk vs Semgrep vs Endor Labs vs Socket vs Aikido vs GHAS](https://nomadlab.cc/blog/2026/05/best-ai-code-security-tools-2026-snyk-semgrep-endor-labs-socket-aikido)
- [Top 5 MCP Gateways for Regulated Industries in 2026 (Maxim AI)](https://www.getmaxim.ai/articles/top-5-mcp-gateways-for-regulated-industries-in-2026/) ·
  [How to Build Audit Trails for AI Coding Agents (MintMCP)](https://www.mintmcp.com/blog/build-audit-trails-ai-coding-agents)
- [AI Governance Trends 2026 (Obot)](https://obot.ai/blog/ai-governance-trends-2026/)
  —— EU AI Act 高风险义务 2026-08-02 生效

> 本文遵循 `docs/SECURITY-AGENT-STRATEGY.md` 的 Guardrails：不宣称官方合作关系，
> 不把他方扫描器的结论当作 Dvalin 的判定，不发布无可复现输入与评分方法的优越性声明。
> 文中引用的竞品能力均为其公开材料的自述。
