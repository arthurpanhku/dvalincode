# DvalinCode Design

DvalinCode is a local-first, agent-compatible security runtime. Its primary
product is the versioned evidence and release gate between code generation and
merge. The bundled coding agent and user interfaces are remediation clients of
that runtime; they are not the source of the security verdict.

## Goals

- Give humans, coding agents, and CI the same deterministic security contract.
- Compete on application-security discovery, triage, governed remediation, and
  independent verification without coupling the result to one model provider.
- Consume and emit portable evidence through SARIF and structured JSON.
- Run independently or work alongside specialist security systems, including
  Codex Security, CodeQL, GitHub Code Scanning, Semgrep, Trivy, and OSV-Scanner.
- Keep discovery and remediation providers replaceable while Dvalin owns the
  policy, audit, baseline, verification, and publication gate.
- Make every tool explicit, typed, locally bounded, and auditable.
- Prefer local context and deterministic checks before optional model calls.

## Non-Goals

- Match every feature of every general coding agent, or turn Dvalin's bundled
  coding executor into the product's trust boundary.
- Claim security superiority or coverage parity without reproducible evidence.
- Treat an imported finding as independently verified merely because it was
  accepted, fixed, or absent from a later SARIF export.
- Reinterpret another product's coverage, sealed scan bundle, credentials, or
  access policy.
- Install or execute third-party scanners merely because they were discovered.
- Execute write, shell, publication, or tracking operations without the
  corresponding policy and approval.
- Bind the security gate to one model vendor or agent environment.

The product boundary, competitive thesis, honest gaps, and implementation
priorities are detailed in [SECURITY-AGENT-STRATEGY.md](SECURITY-AGENT-STRATEGY.md).

## User-Facing Behavior

DvalinCode starts as a normal CLI with subcommands:

- `security scan` / `dvalin scan` runs the independent security gate.
- `security import` / `dvalin import` normalizes a SARIF handoff into local
  remediation cases without executing the source scanner.
- `security verify` / `dvalin verify` resumes a Dvalin workflow and re-runs its
  configured scanners and checks.
- `scan` summarizes a project.
- `tools` lists available capabilities.
- `run-tool` invokes a specific tool with JSON input.
- `ask` creates a local execution brief for a goal.
- `chat` runs the agent loop against a project.
- `init` scaffolds project config.
- `report` renders / verifies a run's audit trail (`--last`, `<run-id>`, `verify`).

The CLI is plain by design; the bundled web GUI is the richer reference client over the same core contracts.

## Core Interfaces

### Tool

```ts
type Tool<Input> = {
  name: string;
  description: string;
  access: 'read' | 'write' | 'execute';
  inputSchema: ZodType<Input>;
  isConcurrencySafe?: (input: Input) => boolean;
  run(input: Input, context: DvalinContext): Promise<ToolResult>;
};
```

### Context

```ts
type DvalinContext = {
  cwd: string;
  allowWrite: boolean;
  allowExecute: boolean;
  maxBytes: number;
  approvalMode: 'readonly' | 'auto-edit' | 'full-auto' | 'bypass';
  requestApproval?: (id: string, toolName: string, input: unknown) => Promise<boolean>;
  audit?: AuditSink;   // per-run audit sink; tool taps emit events when present
};
```

### Tool Result

```ts
type ToolResult = {
  title: string;
  output: string;
  metadata?: Record<string, unknown>;
};
```

## Permission Model

Read tools run by default.

Write and execute tools are blocked unless the caller opts in. The original CLI used a `--yes` flag; the agent runtime now expresses this through `approvalMode` — `readonly` (no writes), `auto-edit` (approve each write), `full-auto`, and `bypass`. Every run is also recorded to a tamper-evident audit log (see [AUDIT-TRAIL.md](AUDIT-TRAIL.md)). A future policy file can enforce constraints at the registry gating layer.

## Provider Model

The current `ask` command uses a deterministic local planner. Future model adapters should live behind a provider interface and receive only curated context plus tool manifests.

Provider adapters should not call tools directly. They should request tool use through the same validated registry used by the CLI.

## Module Layout

```text
src/
├── agent/         AgentLoop state machine, runner, compaction
├── audit/         hash-chained run log, Run Report renderer, taps
├── commands/      CLI command registration (incl. `report`)
├── core/          context, permissions, workspace scanning
├── mcp/           task-level tools for external coding agents
├── providers/     planner and model adapters
├── remediation/   scanner orchestration, SARIF, cases, worktrees
├── security/      versioned gate, baseline, suppressions, workflow
├── server/        Express + WebSocket runtime for the GUI
├── sessions/      session persistence
├── tools/         tool contracts and built-in tools
└── ui/            terminal rendering helpers
```

## Safety Principles

- Validate inputs before running a tool.
- Resolve file paths inside the workspace.
- Keep process execution opt-in.
- Prefer small, inspectable outputs.
- Keep dangerous capabilities out of default flows.
