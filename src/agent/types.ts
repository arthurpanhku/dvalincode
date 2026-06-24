import type { ChatMessage, ToolDef } from '../providers/types.js';
import type { ToolRegistry } from '../tools/registry.js';

export enum TurnState {
  /** Restore session state */
  RESTORE = 'RESTORE',
  /** Compact/compress context if near limit */
  COMPACT = 'COMPACT',
  /** Handle built-in commands (/compact, /retry, /undo) */
  COMMAND = 'COMMAND',
  /** Build system prompt with workspace context */
  BUILD = 'BUILD',
  /** Call LLM and process tool calls in a loop */
  RUN = 'RUN',
  /** Persist session to disk */
  SAVE = 'SAVE',
  /** Format and output response */
  RESPOND = 'RESPOND',
  /** Turn complete */
  DONE = 'DONE',
}

export type TurnConfig = {
  maxIterations: number;
  maxToolCallsPerTurn: number;
  contextTokenLimit: number;
  compactThreshold: number; // 0.0-1.0, fraction of limit that triggers compact
};

export const DEFAULT_TURN_CONFIG: TurnConfig = {
  maxIterations: 10,
  maxToolCallsPerTurn: 15,
  contextTokenLimit: 128_000,
  compactThreshold: 0.7,
};

export type SlashCommand = {
  name: string;
  description: string;
  handler: (args: string, messages: ChatMessage[]) =>
    | { messages: ChatMessage[]; output?: string }
    | Promise<{ messages: ChatMessage[]; output?: string }>;
};

export type LoopResult = {
  messages: ChatMessage[];
  output: string;
  iterationsUsed: number;
  usage?: { inputTokens: number; outputTokens: number };
  /** Audit run id for this turn, when auditing is enabled. */
  runId?: string;
  /** Audit chain head hash after run_end — the checkpoint the session journal anchors to. */
  auditHead?: string;
};

export type ToolResult = {
  title: string;
  output: string;
  metadata?: Record<string, unknown>;
};

export type UndoEntry = {
  toolName: string;
  input: unknown;
  result: ToolResult;
  reverseInput: unknown;
  timestamp: string;
};

export type AgentEvent =
  | { type: 'token_delta'; content: string }
  | { type: 'tool_call'; name: string; id: string; input: unknown }
  | { type: 'tool_result'; name: string; id: string; output: string; metadata?: Record<string, unknown> }
  | { type: 'tool_error'; name: string; id: string; error: string }
  | { type: 'llm_iteration'; iteration: number };

export type AgentEventHandler = (event: AgentEvent) => void;
