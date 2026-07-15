import type { ChatMessage, ChatResponse, TokenUsage, ToolCall, ToolDef, ProviderAdapter } from '../providers/types.js';
import { truncateToolOutput, type ToolRegistry } from '../tools/registry.js';
import type { DvalinContext } from '../core/context.js';
import type { TurnConfig, UndoEntry, AgentEventHandler } from './types.js';
import type { ReverseOp } from '../tools/types.js';
import { estimateRequestTokens } from './compact.js';

export type RunnerOptions = {
  provider: ProviderAdapter;
  registry: ToolRegistry;
  context: DvalinContext;
  config: TurnConfig;
  systemPrompt: string;
  sharedUndoStack?: UndoEntry[];
  compactHistory?: (messages: ChatMessage[], signal?: AbortSignal) => Promise<ChatMessage[]>;
};

/** Carries the completed model/tool state so an interrupted turn can resume. */
export class TurnInterruptedError extends Error {
  constructor(
    readonly messages: ChatMessage[],
    readonly iterationsUsed: number,
    readonly usage?: TokenUsage,
  ) {
    super('interrupted');
    this.name = 'TurnInterruptedError';
  }
}

const PENDING_WORK_NUDGE = [
  'Runtime completion check: your previous response described work that is still pending.',
  'Continue the task now by calling the next required tool. Do not merely describe what you will do.',
  'Only return a response without tool calls when the requested task and its focused validation are complete.',
].join(' ');

const INVESTIGATION_NUDGE = [
  'Runtime investigation check: the first requested action was a source edit, so it was deferred once.',
  'Before editing, reproduce or inspect the failure and use read/search/command evidence to identify the responsible file and line.',
  'Then retry the smallest justified edit and rerun the focused failing check.',
].join(' ');

const STALL_NUDGE = [
  'Runtime progress check: recent actions show no new evidence or verification.',
  'Pause the current approach, restate the leading hypothesis from observed results, and choose a materially different diagnostic step.',
  'Do not repeat the same command or keep editing the same area without a new read or focused check.',
].join(' ');

const WRITE_TOOLS = new Set(['edit_file', 'write_file', 'delete_file']);
const INVESTIGATION_TOOLS = new Set([
  'read_file',
  'search_text',
  'list_files',
  'git_diff',
  'git_status',
  'project_scripts',
  'run_check',
  'shell',
]);

type StallState = {
  recentActions: string[];
  recentLabels: string[];
  lastSignature?: string;
  repeatCount: number;
  consecutiveEdits: number;
  writeGeneration: number;
  lastFailedTest?: { signature: string; writeGeneration: number; count: number };
};

/** Detect a process update that must not be mistaken for a final answer. */
export function looksLikePendingWork(content: string, finishReason?: string): boolean {
  if (finishReason === 'length' || finishReason === 'max_tokens') return true;
  const text = content.trim();
  if (!text) return true;

  const englishFutureAction = /\b(?:let me|i(?:'ll| will| need to| am going to)|next,?\s+i(?:'ll| will)|now,?\s+i(?:'ll| will))\s+(?:check|inspect|verify|validate|fix|edit|update|add|run|test|implement|continue|review|open|read|write|create|remove|ensure)\b/i;
  const chineseFutureAction = /(?:让我|我(?:将|会|需要|准备)|接下来|下一步|现在(?:让我|我来|我将|我要)|继续)(?:检查|验证|确认|修复|修改|更新|添加|运行|测试|实现|继续|查看|读取|编写|创建|删除|确保|完成)/;
  const explicitIncomplete = /\b(?:still need to|work remains|remaining steps?)\b|(?:还需要|尚未完成|仍需|待完成)/i;
  return englishFutureAction.test(text) || chineseFutureAction.test(text) || explicitIncomplete.test(text);
}

export class AgentRunner {
  private provider: ProviderAdapter;
  private registry: ToolRegistry;
  private context: DvalinContext;
  private config: TurnConfig;
  private systemPrompt: string;
  private iterationCount: number = 0;
  private compactHistory?: RunnerOptions['compactHistory'];

  /** Stack of executed tool calls for undo support */
  private undoStack: UndoEntry[];

  constructor(options: RunnerOptions) {
    this.provider = options.provider;
    this.registry = options.registry;
    this.context = options.context;
    this.config = options.config;
    this.systemPrompt = options.systemPrompt;
    this.undoStack = options.sharedUndoStack ?? [];
    this.compactHistory = options.compactHistory;
  }

  /** Undo the last N tool calls. Returns a description of what was undone. */
  async undoLast(count: number = 1): Promise<string> {
    if (this.undoStack.length === 0) {
      return 'Nothing to undo.';
    }
    const entries = this.undoStack.splice(-count);
    const descriptions: string[] = [];
    for (const entry of entries) {
      const tool = this.registry.get(entry.toolName);
      if (!tool || !tool.isUndoable) {
        descriptions.push(`Cannot undo ${entry.toolName}: undo not supported.`);
        continue;
      }
      const reverseOp = tool.reverse?.(entry.input, entry.result) as ReverseOp | undefined;
      if (!reverseOp) {
        descriptions.push(`Cannot undo ${entry.toolName}: reverse operation not available (file may have existed before).`);
        continue;
      }
      try {
        const reverseTool = this.registry.get(reverseOp.toolName);
        if (!reverseTool) {
          descriptions.push(`Cannot undo ${entry.toolName}: reverse tool "${reverseOp.toolName}" not found.`);
          continue;
        }
        await reverseTool.run(reverseOp.input, this.context);
        descriptions.push(`✅ ${reverseOp.description}`);
      } catch (err) {
        descriptions.push(`❌ Undo failed for ${entry.toolName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return descriptions.join('\n');
  }

  /** Run a single turn: user message → LLM → (tool calls → LLM) → final response */
  async runTurn(
    userMessage: string,
    history: ChatMessage[],
    onEvent?: AgentEventHandler,
    signal?: AbortSignal,
  ): Promise<{ messages: ChatMessage[]; finalResponse: string; iterationsUsed: number; usage?: TokenUsage }> {
    let messages: ChatMessage[] = [...history, { role: 'user', content: userMessage }];
    this.iterationCount = 0;
    let totalUsage: TokenUsage | undefined;
    let lastCompactionAtTokens = 0;
    let totalToolCalls = 0;
    let hasInvestigated = history.some(
      message => message.role === 'tool' && Boolean(message.name && INVESTIGATION_TOOLS.has(message.name)),
    );
    let investigationNudged = false;
    let stallNudges = 0;
    const changedFiles = new Set<string>();
    const stall: StallState = {
      recentActions: [],
      recentLabels: [],
      repeatCount: 0,
      consecutiveEdits: 0,
      writeGeneration: 0,
    };

    try {
      while (this.iterationCount < this.config.maxIterations) {
        if (signal?.aborted) throw new Error('interrupted');
        this.iterationCount++;
        onEvent?.({ type: 'llm_iteration', iteration: this.iterationCount });

        // Build tool definitions from registry
        const toolDefs = this.buildToolDefs();

        // Long coding turns grow after every tool result. Compact at iteration
        // boundaries so the turn can continue instead of hitting the provider's
        // context limit halfway through the task.
        const triggerTokens = this.config.contextTokenLimit * this.config.compactThreshold;
        const requestTokens = estimateRequestTokens(messages, this.systemPrompt, toolDefs);
        if (
          this.compactHistory &&
          requestTokens > triggerTokens &&
          requestTokens > lastCompactionAtTokens + 1_000
        ) {
          lastCompactionAtTokens = requestTokens;
          messages = await this.compactHistory(messages, signal);
          if (signal?.aborted) throw new Error('interrupted');
        }

        // Call LLM (streaming if onEvent is provided)
        const response: ChatResponse = await this.provider.chat({
          system: this.systemPrompt,
          messages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          signal,
          onDelta: onEvent ? (delta) => onEvent({ type: 'token_delta', content: delta }) : undefined,
          runtime: {
            policy: this.context.policy,
            audit: this.context.audit,
          },
        });

        // Accumulate token usage across all iterations
        if (response.usage) {
          totalUsage = accumulateUsage(totalUsage, response.usage);
        }

        // Add assistant message — include tool_calls if present (required by OpenAI-compatible APIs)
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: response.content,
          tool_calls: response.toolCalls && response.toolCalls.length > 0 ? response.toolCalls : undefined,
        };
        messages.push(assistantMsg);

        // Check for tool calls — prefer native API response, fallback to @tool() text parsing
        let toolCalls: ToolCall[] = [];
        if (response.toolCalls && response.toolCalls.length > 0) {
          toolCalls = response.toolCalls;
        } else {
          toolCalls = this.parseToolCalls(response.content);
        }
        if (toolCalls.length === 0) {
          // Some models occasionally emit a narration such as "let me verify
          // the file" without the promised tool call. Treat that as an
          // incomplete checkpoint and immediately ask for the actual action.
          if (looksLikePendingWork(response.content, response.finishReason)) {
            // Keep the request prefix append-only so provider prompt caches can
            // reuse every prior message on the next iteration.
            messages.push({ role: 'user', content: PENDING_WORK_NUDGE });
            continue;
          }
          // A tool-free response with no pending-work signal is the final answer.
          return { messages, finalResponse: response.content, iterationsUsed: this.iterationCount, usage: totalUsage };
        }

        // Enforce the budget across the entire turn. Previously this slice was
        // reset on every model iteration, so a nominal 15-call limit could grow
        // to hundreds of actions and make simple tasks spiral.
        const remainingToolCalls = Math.max(0, this.config.maxToolCallsPerTurn - totalToolCalls);
        const callsToExecute = toolCalls.slice(0, remainingToolCalls);
        const skippedCalls = toolCalls.slice(remainingToolCalls);

        let deferredFirstEdit = false;
        let stallReason: string | undefined;

        // Execute tool calls
        for (const tc of callsToExecute) {
          if (signal?.aborted) throw new Error('interrupted');
          let parsedInput: unknown;
          try {
            parsedInput = JSON.parse(tc.arguments);

            // A one-shot soft gate prevents a model from acting directly on
            // issue wording before it has gathered any workspace evidence.
            if (WRITE_TOOLS.has(tc.name) && !hasInvestigated && !investigationNudged) {
              investigationNudged = true;
              deferredFirstEdit = true;
              const error = 'Deferred once: inspect/reproduce and locate the responsible code before the first source edit.';
              onEvent?.({ type: 'tool_error', name: tc.name, id: tc.id, error });
              messages.push({
                role: 'tool',
                content: `[Tool ${tc.name} error]: ${error}`,
                tool_call_id: tc.id,
                name: tc.name,
              });
              observeAction(stall, tc.name, parsedInput, undefined, error, this.config);
              totalToolCalls++;
              continue;
            }

            onEvent?.({ type: 'tool_call', name: tc.name, id: tc.id, input: parsedInput });
            const result = await this.registry.run(
              tc.name,
              parsedInput,
              signal ? { ...this.context, signal } : this.context,
            );
            const bounded = truncateToolOutput(result.output, this.config.maxToolResultBytes ?? 32_000);
            const visibleResult = bounded.output;

            // Record undo entry for this tool call
            this.undoStack.push({
              toolName: tc.name,
              input: parsedInput,
              result: {
                title: result.title,
                output: visibleResult,
                metadata: result.metadata,
              },
              reverseInput: null,
              timestamp: new Date().toISOString(),
            });

            onEvent?.({
              type: 'tool_result',
              name: tc.name,
              id: tc.id,
              output: visibleResult,
              metadata: bounded.truncated
                ? { ...result.metadata, outputTruncated: true, omittedBytes: bounded.omittedBytes }
                : result.metadata,
            });
            messages.push({
              role: 'tool',
              content: `[Tool ${tc.name} result]:\n${visibleResult}`,
              tool_call_id: tc.id,
              name: tc.name,
            });
            if (INVESTIGATION_TOOLS.has(tc.name)) hasInvestigated = true;
            if (WRITE_TOOLS.has(tc.name)) {
              const path = toolPath(parsedInput);
              if (path) changedFiles.add(path);
            }
            stallReason ??= observeAction(stall, tc.name, parsedInput, result.metadata, undefined, this.config);
          } catch (err) {
            if (signal?.aborted) throw err;
            const error = err instanceof Error ? err.message : String(err);
            onEvent?.({ type: 'tool_error', name: tc.name, id: tc.id, error });
            messages.push({
              role: 'tool',
              content: `[Tool ${tc.name} error]: ${error}`,
              tool_call_id: tc.id,
              name: tc.name,
            });
            stallReason ??= observeAction(stall, tc.name, parsedInput ?? tc.arguments, undefined, error, this.config);
          }
          totalToolCalls++;
        }

        if (deferredFirstEdit) {
          messages.push({ role: 'user', content: INVESTIGATION_NUDGE });
        }

        // Native tool-call protocols require one tool response for every call
        // in the assistant message, including calls rejected by the budget.
        for (const tc of skippedCalls) {
          const error = `Skipped: reached the ${this.config.maxToolCallsPerTurn}-action turn limit.`;
          onEvent?.({ type: 'tool_error', name: tc.name, id: tc.id, error });
          messages.push({
            role: 'tool',
            content: `[Tool ${tc.name} error]: ${error}`,
            tool_call_id: tc.id,
            name: tc.name,
          });
        }

        if (totalToolCalls >= this.config.maxToolCallsPerTurn || skippedCalls.length > 0) {
          return {
            messages,
            finalResponse: `Task paused after ${totalToolCalls} actions, the configured per-turn safety limit. Review the completed actions or send "continue" if more work is needed.`,
            iterationsUsed: this.iterationCount,
            usage: totalUsage,
          };
        }

        if (stallReason) {
          if (stallNudges === 0) {
            stallNudges++;
            messages.push({ role: 'user', content: `${STALL_NUDGE}\n\nDetected: ${stallReason}` });
            resetStallCheckpoint(stall);
            continue;
          }
          return {
            messages,
            finalResponse: renderStallSummary(stallReason, changedFiles, stall.recentLabels),
            iterationsUsed: this.iterationCount,
            usage: totalUsage,
          };
        }
      }
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.message === 'interrupted')) {
        throw new TurnInterruptedError(messages, this.iterationCount, totalUsage);
      }
      throw err;
    }

    // Max iterations reached
    const lastMsg = messages.filter(m => m.role === 'assistant').pop();
    const detail = lastMsg?.content.trim();
    return {
      messages,
      finalResponse: [
        detail,
        `Task paused after reaching the ${this.config.maxIterations}-iteration safety limit. Send \"continue\" to resume from the saved tool state.`,
      ].filter(Boolean).join('\n\n'),
      iterationsUsed: this.iterationCount,
      usage: totalUsage,
    };
  }

  private buildToolDefs(): ToolDef[] {
    return this.registry.list().map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parametersSchema ?? tool.inputSchema.toJSONSchema?.() ?? {},
    }));
  }

  private parseToolCalls(content: string): ToolCall[] {
    const calls: ToolCall[] = [];
    // Pattern: @tool(name, {...arguments})
    const regex = /@tool\s*\(\s*["']([^"']+)["']\s*,\s*({[^}]+})\s*\)/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      calls.push({
        id: `tc_${calls.length}`,
        name: match[1],
        arguments: match[2],
      });
    }
    return calls;
  }
}

function accumulateUsage(total: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  const merged: TokenUsage = {
    inputTokens: (total?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + next.outputTokens,
  };
  for (const key of ['cachedInputTokens', 'cacheMissInputTokens', 'cacheWriteInputTokens'] as const) {
    const value = (total?.[key] ?? 0) + (next[key] ?? 0);
    if (value > 0 || total?.[key] !== undefined || next[key] !== undefined) merged[key] = value;
  }
  return merged;
}

function observeAction(
  state: StallState,
  toolName: string,
  input: unknown,
  metadata: Record<string, unknown> | undefined,
  error: string | undefined,
  config: TurnConfig,
): string | undefined {
  const signature = `${toolName}:${stableStringify(input)}`;
  const label = `${toolName} ${summarizeInput(input)}`.trim();
  const window = Math.max(2, config.stallWindow ?? 8);
  state.recentActions.push(signature);
  state.recentLabels.push(label);
  if (state.recentActions.length > window) state.recentActions.shift();
  if (state.recentLabels.length > window) state.recentLabels.shift();

  if (signature === state.lastSignature) state.repeatCount++;
  else {
    state.lastSignature = signature;
    state.repeatCount = 1;
  }

  if (WRITE_TOOLS.has(toolName) && !error) {
    state.consecutiveEdits++;
    state.writeGeneration++;
  } else if (INVESTIGATION_TOOLS.has(toolName)) {
    state.consecutiveEdits = 0;
  }

  const maxRepeats = Math.max(2, config.maxRepeats ?? 2);
  if (state.repeatCount >= maxRepeats) {
    return `the exact action “${label}” repeated ${state.repeatCount} times consecutively`;
  }

  const exitCode = typeof metadata?.exitCode === 'number' ? metadata.exitCode : undefined;
  if (isTestAction(toolName, input) && (error || (exitCode !== undefined && exitCode !== 0))) {
    const prior = state.lastFailedTest;
    if (prior?.signature === signature && prior.writeGeneration === state.writeGeneration) {
      prior.count++;
    } else {
      state.lastFailedTest = { signature, writeGeneration: state.writeGeneration, count: 1 };
    }
    if ((state.lastFailedTest?.count ?? 0) >= maxRepeats) {
      return `the same focused check failed ${state.lastFailedTest!.count} times without an intervening source edit`;
    }
  }

  const maxUnverifiedEdits = Math.max(2, config.maxUnverifiedEdits ?? 4);
  if (state.consecutiveEdits >= maxUnverifiedEdits) {
    return `${state.consecutiveEdits} consecutive source edits were made without a read, diff, or validation step`;
  }
  return undefined;
}

function resetStallCheckpoint(state: StallState): void {
  state.recentActions = [];
  state.recentLabels = [];
  state.lastSignature = undefined;
  state.repeatCount = 0;
  state.consecutiveEdits = 0;
  state.lastFailedTest = undefined;
}

function renderStallSummary(reason: string, changedFiles: Set<string>, recentLabels: string[]): string {
  const files = changedFiles.size > 0 ? [...changedFiles].sort().join(', ') : 'none';
  const actions = recentLabels.length > 0 ? recentLabels.map(action => `- ${action}`).join('\n') : '- none';
  return [
    'Task paused early because the agent remained stalled after a corrective checkpoint.',
    '',
    `Stall reason: ${reason}.`,
    `Files changed this turn: ${files}.`,
    'Recent actions:',
    actions,
    '',
    'Resume with a different hypothesis or provide additional diagnostic context.',
  ].join('\n');
}

function toolPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>).filePath;
  return typeof value === 'string' ? value : undefined;
}

function isTestAction(toolName: string, input: unknown): boolean {
  if (toolName === 'run_check') return (input as { kind?: unknown } | undefined)?.kind === 'test';
  if (toolName !== 'shell' || !input || typeof input !== 'object') return false;
  const record = input as Record<string, unknown>;
  const command = [record.command, ...(Array.isArray(record.args) ? record.args : [])].join(' ');
  return /\b(?:pytest|py\.test|vitest|jest|test|check)\b/i.test(command);
}

function summarizeInput(input: unknown): string {
  const text = stableStringify(input);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
