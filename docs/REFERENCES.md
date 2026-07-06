# References and Attributions

DvalinCode is an original project. Several design decisions were informed by prior art in the open-source agent ecosystem and published research. This document lists those sources so that the lineage is clear and auditable.

---

## HKUDS/nanobot

**Repository:** https://github.com/HKUDS/nanobot  
**Package:** `nanobot-ai` (PyPI)  
**License:** MIT  
**Authors:** HKUDS Lab

The **`TurnState` state-machine design** in DvalinCode (`src/agent/types.ts`) was informed by the equivalent structure in nanobot's agent loop (`nanobot/agent/loop.py`). Both define an explicit enum that drives a single conversation turn through the following phases:

| Phase | Purpose |
|---|---|
| `RESTORE` | Reload session history from persistent storage |
| `COMMAND` | Intercept and handle slash commands before the LLM sees the turn |
| `BUILD` | Assemble the context window (system prompt + history + injections) |
| `RUN` | Call the LLM; execute tool calls in a loop until the model stops |
| `SAVE` | Persist the completed turn to session storage |
| `RESPOND` | Stream or deliver the final response to the client |
| `DONE` | Terminal state; clean up and signal completion |

DvalinCode's implementation differs from nanobot in several ways: it is written in TypeScript rather than Python; it targets any OpenAI-compatible API rather than a fixed provider; it adds an explicit undo stack (`UndoEntry[]`) not present in nanobot; and context compaction is handled as a separate trigger path rather than an enum state.

The state names and their sequencing are what was directly referenced. No source code, prompts, or proprietary assets were copied.

---

## ReAct: Synergizing Reasoning and Acting in Language Models

**Citation:** Yao, S., Zhao, J., Yu, D., Du, N., Shafran, I., Narasimhan, K., & Cao, Y. (2022). *ReAct: Synergizing Reasoning and Acting in Language Models.* arXiv:2210.03629.  
**URL:** https://arxiv.org/abs/2210.03629

The core `RUN` loop — "think, call tools, observe results, repeat" — implements the **ReAct** (Reason + Act) paradigm described in this paper. ReAct is now the standard architecture for LLM agent loops across the industry (LangChain AgentExecutor, OpenAI Assistants, Claude Code, and others all follow the same pattern). DvalinCode's implementation in `src/agent/runner.ts` (`AgentRunner.runIteration`) is an independent TypeScript realization of the same idea.

---

## OpenAI tool_calls Protocol

**Specification:** OpenAI Chat Completions API — Tool Use  
**URL:** https://platform.openai.com/docs/guides/function-calling

DvalinCode's tool-calling interface (`src/agent/runner.ts: parseToolCalls`) follows the OpenAI `tool_calls` message format: a list of `{ id, type: "function", function: { name, arguments } }` objects in the assistant message. This format has become a de facto standard supported by DeepSeek, Mistral, Ollama, and other OpenAI-compatible providers. DvalinCode also implements a text-based `@tool("name", {...})` fallback regex for models that do not emit structured tool calls.

---

## Context Compaction Pattern

The `/compact` feature — summarizing conversation history with the LLM itself when the context window fills — is a pattern independently developed by several agent frameworks, including nanobot (`nanobot/agent/autocompact.py`) and Claude Code. DvalinCode's implementation (`src/agent/compact.ts`) is an independent realization: it calls the configured provider with a structured five-section summarization prompt and replaces the message history with the resulting summary. The general idea is common knowledge in the agent-engineering community; no specific implementation was copied.

---

## Product and Workflow Prior Art

DvalinCode's product direction was informed by public user expectations around
modern coding agents, including OpenAI Codex / Codex CLI, Claude Code, Aider,
opencode, Cursor, Cline, and similar tools. The referenced ideas are high-level
workflow patterns observed from public documentation, release notes, issues, and
community feedback:

| Pattern | How DvalinCode interprets it |
|---|---|
| Terminal coding agent | A lightweight CLI entrypoint with streaming output and slash commands |
| Permission modes | Explicit user control over read, write, and command execution behavior |
| Plan/build separation | A read-only planning mode before applying code changes |
| Diff-first editing | Show proposed filesystem changes before or during approval |
| Project-local context | Work against a selected folder, Git clone, or Git worktree |
| Project instructions | Read project-local instruction files such as `AGENTS.md` as contextual guidance |
| Session lifecycle | Store, restore, replay, and eventually archive agent sessions |
| MCP integration | Treat remote or local tools as governed agent tools rather than unrestricted plugins |

### OpenAI Codex / Codex CLI

Public Codex CLI behavior, release notes, GitHub issues, and community feedback
informed DvalinCode's requirements analysis around `AGENTS.md`, approval modes,
sandboxing, session lifecycle, MCP schema preservation, multi-agent workflows,
and permission profiles. DvalinCode does not copy Codex source code, prompts, UI
text, command names beyond common ecosystem terms, or proprietary assets.

### opencode

Public opencode release notes and product behavior informed requirements
research around background agents, MCP hardening, session/workspace mobility,
replay behavior, and edit-safety expectations. DvalinCode does not copy opencode
source code, prompts, UI text, command names, or proprietary assets.

### Claude Code, Aider, Cursor, and Cline

These tools helped clarify user expectations around terminal-first workflows,
project-local context, permission prompts, diff-first editing, checkpoint/rewind
style recovery, and IDE-adjacent agent experiences. DvalinCode's implementation
is independent.

These products helped clarify what developers expect from agentic coding tools.
DvalinCode's UI, prompts, tool schemas, command names, and implementation are
independent.

---

## Security and Governance Ecosystem

DvalinCode's security and approvability features are shaped by established
security tooling and governance standards:

| Source | Influence |
|---|---|
| CodeQL and GitHub Code Scanning | SARIF-based vulnerability intake and CI/code-scanning posture |
| Semgrep | Lightweight local/static scanning workflow inspiration |
| SARIF | Interchange format for security findings |
| OpenSSF Scorecard | Supply-chain security signal and repository hardening evidence |
| ISO/IEC 42001 | AI management system vocabulary for scope, roles, risk, and evidence |
| Git worktree | Isolated remediation branches/workspaces for focused fixes |
| Model Context Protocol (MCP) | Tool discovery/invocation vocabulary, adapted behind DvalinCode's policy and egress controls |

These are ecosystem references and interoperability targets, not affiliation
claims or certification claims.
