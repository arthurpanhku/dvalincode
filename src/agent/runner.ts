import type { ChatMessage, ChatResponse, ToolCall, ToolDef, ProviderAdapter } from '../providers/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { DvalinContext } from '../core/context.js';
import type { TurnConfig, UndoEntry, AgentEventHandler } from './types.js';
import type { ReverseOp } from '../tools/types.js';

export type RunnerOptions = {
  provider: ProviderAdapter;
  registry: ToolRegistry;
  context: DvalinContext;
  config: TurnConfig;
  systemPrompt: string;
  sharedUndoStack?: UndoEntry[];
};

export class AgentRunner {
  private provider: ProviderAdapter;
  private registry: ToolRegistry;
  private context: DvalinContext;
  private config: TurnConfig;
  private systemPrompt: string;
  private iterationCount: number = 0;

  /** Stack of executed tool calls for undo support */
  private undoStack: UndoEntry[];

  constructor(options: RunnerOptions) {
    this.provider = options.provider;
    this.registry = options.registry;
    this.context = options.context;
    this.config = options.config;
    this.systemPrompt = options.systemPrompt;
    this.undoStack = options.sharedUndoStack ?? [];
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
  ): Promise<{ messages: ChatMessage[]; finalResponse: string; iterationsUsed: number; usage?: { inputTokens: number; outputTokens: number } }> {
    const messages: ChatMessage[] = [...history, { role: 'user', content: userMessage }];
    this.iterationCount = 0;
    let totalUsage: { inputTokens: number; outputTokens: number } | undefined;

    while (this.iterationCount < this.config.maxIterations) {
      if (signal?.aborted) throw new Error('interrupted');
      this.iterationCount++;

      // Build tool definitions from registry
      const toolDefs = this.buildToolDefs();

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
        if (!totalUsage) totalUsage = { inputTokens: 0, outputTokens: 0 };
        totalUsage.inputTokens += response.usage.inputTokens;
        totalUsage.outputTokens += response.usage.outputTokens;
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
        // No tool calls — this is the final response
        return { messages, finalResponse: response.content, iterationsUsed: this.iterationCount, usage: totalUsage };
      }

      // Cap tool calls per turn
      const callsToExecute = toolCalls.slice(0, this.config.maxToolCallsPerTurn);

      // Execute tool calls
      for (const tc of callsToExecute) {
        try {
          const parsedInput = JSON.parse(tc.arguments);
          onEvent?.({ type: 'tool_call', name: tc.name, id: tc.id, input: parsedInput });
          const result = await this.registry.run(tc.name, parsedInput, this.context);

          // Record undo entry for this tool call
          this.undoStack.push({
            toolName: tc.name,
            input: parsedInput,
            result: {
              title: result.title,
              output: result.output,
              metadata: result.metadata,
            },
            reverseInput: null,
            timestamp: new Date().toISOString(),
          });

          onEvent?.({ type: 'tool_result', name: tc.name, id: tc.id, output: result.output, metadata: result.metadata });
          messages.push({
            role: 'tool',
            content: `[Tool ${tc.name} result]:\n${result.output}`,
            tool_call_id: tc.id,
            name: tc.name,
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          onEvent?.({ type: 'tool_error', name: tc.name, id: tc.id, error });
          messages.push({
            role: 'tool',
            content: `[Tool ${tc.name} error]: ${error}`,
            tool_call_id: tc.id,
            name: tc.name,
          });
        }
      }
    }

    // Max iterations reached
    const lastMsg = messages.filter(m => m.role === 'assistant').pop();
    return {
      messages,
      finalResponse: lastMsg?.content ?? 'Max iterations reached without final response.',
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
