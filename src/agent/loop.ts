import { TurnState, type TurnConfig, type LoopResult, type SlashCommand, type AgentEventHandler, DEFAULT_TURN_CONFIG, type UndoEntry } from './types.js';
import { AgentRunner, TurnInterruptedError } from './runner.js';
import { buildCompactedHistory, estimateRequestTokens, summarizeWithLLM } from './compact.js';
import { AuditSink, newRunId, resolveGitHead } from '../audit/log.js';
import { minimizedDescriptor } from '../audit/minimize.js';
import { policyHash, type LoadedPolicy } from '../core/policy.js';
import type { ChatMessage } from '../providers/types.js';
import type { ProviderAdapter } from '../providers/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { DvalinContext } from '../core/context.js';

/** Per-run audit configuration for the agent loop. */
export type AuditOptions = {
  /** Disable to skip audit logging entirely (default: enabled). */
  enabled?: boolean;
  /** Override the audit directory (defaults to ~/.dvalincode/audit). */
  dir?: string;
  /** Model name recorded in run_start (the adapter only exposes its provider name). */
  model?: string;
  /** Resolved org policy + provenance, recorded in run_start for tamper-evidence. */
  policy?: LoadedPolicy;
  /** Session id recorded in run_start, linking the audit chain to the session journal. */
  sessionId?: string;
};

export type AgentLoopOptions = {
  provider: ProviderAdapter;
  registry: ToolRegistry;
  context: DvalinContext;
  systemPrompt: string;
  config?: Partial<TurnConfig>;
  slashCommands?: SlashCommand[];
  audit?: AuditOptions;
};

export class AgentLoop {
  private provider: ProviderAdapter;
  private registry: ToolRegistry;
  private context: DvalinContext;
  private systemPrompt: string;
  private config: TurnConfig;
  private slashCommands: Map<string, SlashCommand>;
  private sharedUndoStack: UndoEntry[] = [];
  private auditOptions: AuditOptions;

  constructor(options: AgentLoopOptions) {
    this.provider = options.provider;
    this.registry = options.registry;
    this.context = options.context;
    this.systemPrompt = options.systemPrompt;
    this.config = { ...DEFAULT_TURN_CONFIG, ...options.config };
    this.auditOptions = options.audit ?? {};

    this.slashCommands = new Map();
    const cmds = options.slashCommands ?? [];
    for (const cmd of cmds) {
      this.slashCommands.set(cmd.name, cmd);
    }
    // Register built-in commands
    this.slashCommands.set('compact', {
      name: 'compact',
      description: 'Compress conversation context using LLM summarization',
      handler: async (_args, messages) => this.handleCompact(messages),
    });
    this.slashCommands.set('undo', {
      name: 'undo',
      description: 'Undo the last N tool calls (default: 1)',
      handler: async (args, messages) => {
        const count = parseInt(args.trim(), 10);
        const n = Number.isFinite(count) && count > 0 ? count : 1;
        const runner = new AgentRunner({
          provider: this.provider,
          registry: this.registry,
          context: this.context,
          config: this.config,
          systemPrompt: this.systemPrompt,
          sharedUndoStack: this.sharedUndoStack,
        });
        const undoOutput = await runner.undoLast(n);
        return { messages, output: undoOutput };
      },
    });
    this.slashCommands.set('help', {
      name: 'help',
      description: 'List available slash commands',
      handler: (_args, messages) => ({
        messages,
        output: [
          '**Available slash commands:**',
          '',
          '| Command | Description |',
          '|---------|-------------|',
          '| `/clear` | Clear conversation (client-side) |',
          '| `/compact` | Compress context to save tokens |',
          '| `/undo [N]` | Undo the last N tool calls (default: 1) |',
          '| `/git` | Show git branch, commits, changed files |',
          '| `/plan` | Plan the task before executing |',
          '| `/help` | Show this help |',
        ].join('\n'),
      }),
    });
    this.slashCommands.set('git', {
      name: 'git',
      description: 'Show git status',
      handler: (_args, messages) => ({
        messages: [...messages, { role: 'user' as const, content: 'Run git_status to show the current git branch, recent commits, and changed files.' }],
      }),
    });
    this.slashCommands.set('plan', {
      name: 'plan',
      description: 'Plan before executing',
      handler: (args, messages) => ({
        messages: [...messages, {
          role: 'user' as const,
          content: `Create a detailed step-by-step plan for the following task. List each step clearly with a numbered list. Do NOT execute any steps yet — only plan.\n\nTask: ${args || '(describe the task)'}`,
        }],
      }),
    });
  }

  /** Process a user message through the full state machine */
  async processMessage(userMessage: string, history: ChatMessage[], onEvent?: AgentEventHandler, signal?: AbortSignal): Promise<LoopResult> {
    let messages = [...history];
    let state: TurnState | string = TurnState.RESTORE;

    // Pre-allocated output
    let output = '';
    let iterationsUsed = 0;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let runId: string | undefined;
    let auditHead: string | undefined;

    while (state !== TurnState.DONE) {
      switch (state) {
        case TurnState.RESTORE: {
          // Auto-compact: if the running history already exceeds the configured
          // fraction of the context window, summarize it before building the
          // next turn. Wires up `contextTokenLimit` / `compactThreshold`, which
          // were defined but previously never consulted by the state machine.
          const triggerTokens = this.config.contextTokenLimit * this.config.compactThreshold;
          const toolDefs = this.registry.list().map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parametersSchema ?? tool.inputSchema.toJSONSchema?.() ?? {},
          }));
          if (estimateRequestTokens(messages, this.systemPrompt, toolDefs) > triggerTokens) {
            state = TurnState.COMPACT;
          } else {
            state = TurnState.BUILD;
          }
          break;
        }

        case TurnState.COMPACT: {
          const compacted = await this.handleCompact(messages, signal, true);
          messages = compacted.messages;
          state = TurnState.BUILD;
          break;
        }

        case TurnState.COMMAND: {
          // Check if user message starts with /
          if (userMessage.startsWith('/')) {
            const spaceIdx = userMessage.indexOf(' ');
            const cmdName = spaceIdx === -1 ? userMessage.slice(1) : userMessage.slice(1, spaceIdx);
            const args = spaceIdx === -1 ? '' : userMessage.slice(spaceIdx + 1);
            const cmd = this.slashCommands.get(cmdName);
            if (cmd) {
              const result = await Promise.resolve(cmd.handler(args, messages));
              messages = result.messages;
              if (result.output) output = result.output;
              state = TurnState.DONE;
              break;
            }
          }
          state = TurnState.RUN;
          break;
        }

        case TurnState.BUILD: {
          state = TurnState.COMMAND;
          break;
        }

        case TurnState.RUN: {
          // Open a per-run audit sink (one file per user turn) unless disabled.
          let sink: AuditSink | undefined;
          let runContext = this.context;
          if (this.auditOptions.enabled !== false) {
            runId = newRunId();
            sink = new AuditSink(runId, this.auditOptions.dir);
            sink.append({
              type: 'run_start',
              task: minimizedDescriptor(userMessage),
              mode: this.context.approvalMode,
              provider: this.provider.name,
              model: this.auditOptions.model ?? 'unknown',
              cwd: this.context.cwd,
              gitHead: await resolveGitHead(this.context.cwd),
              sessionId: this.auditOptions.sessionId,
              policyHash: this.auditOptions.policy?.hash ?? policyHash(this.context.policy),
              policySources: this.auditOptions.policy?.sources,
            });
            runContext = { ...this.context, audit: sink };
          }

          const runner = new AgentRunner({
            provider: this.provider,
            registry: this.registry,
            context: runContext,
            config: this.config,
            systemPrompt: this.systemPrompt,
            sharedUndoStack: this.sharedUndoStack,
            compactHistory: async (current, compactSignal) =>
              (await this.handleCompact(current, compactSignal, true)).messages,
          });

          try {
            const result = await runner.runTurn(userMessage, messages, onEvent, signal);
            messages = result.messages;
            output = result.finalResponse;
            iterationsUsed = result.iterationsUsed;
            usage = result.usage;
            this.finishRun(sink, 'done', iterationsUsed, usage);
            auditHead = sink?.head();
          } catch (err) {
            if (err instanceof TurnInterruptedError) {
              iterationsUsed = err.iterationsUsed;
              usage = err.usage;
            }
            const status = err instanceof Error && err.message === 'interrupted' ? 'interrupted' : 'error';
            this.finishRun(sink, status, iterationsUsed, usage);
            throw err;
          }
          state = TurnState.SAVE;
          break;
        }

        case TurnState.SAVE: {
          state = TurnState.RESPOND;
          break;
        }

        case TurnState.RESPOND: {
          state = TurnState.DONE;
          break;
        }
      }
    }

    return { messages, output, iterationsUsed, usage, runId, auditHead };
  }

  /** Emit the terminal run_end event, folding in any best-effort write warnings. */
  private finishRun(
    sink: AuditSink | undefined,
    status: 'done' | 'interrupted' | 'error',
    iterations: number,
    usage: { inputTokens: number; outputTokens: number } | undefined,
  ): void {
    if (!sink) return;
    const warnings = sink.getWarnings();
    sink.append({
      type: 'run_end',
      status,
      iterations,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  }

  private async handleCompact(
    messages: ChatMessage[],
    signal?: AbortSignal,
    force = false,
  ): Promise<{ messages: ChatMessage[]; output?: string }> {
    if (!force && messages.length <= 10) {
      return { messages, output: 'Context is already small enough.' };
    }

    try {
      const summary = await summarizeWithLLM(messages, this.provider, {
        policy: this.context.policy,
        audit: this.context.audit,
        model: this.auditOptions.model,
      }, signal);
      if (signal?.aborted) throw new Error('interrupted');
      const kept = buildCompactedHistory(summary);
      return {
        messages: kept,
        output: `Compacted: reduced from ${messages.length} to ${kept.length} messages using LLM summarization.`,
      };
    } catch (err) {
      if (signal?.aborted) throw new Error('interrupted');
      // Fallback: keep last 20 messages
      const systemMsg = messages.find(m => m.role === 'system');
      const recentMessages = messages.filter(m => m.role !== 'system').slice(-20);
      const kept = systemMsg ? [systemMsg, ...recentMessages] : recentMessages;
      return {
        messages: kept,
        output: `Compacted (fallback): reduced from ${messages.length} to ${kept.length} messages.`,
      };
    }
  }
}
