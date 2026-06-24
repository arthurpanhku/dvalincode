import type { z } from 'zod';
import type { AuditSink } from '../audit/log.js';
import type { ResolvedPolicy } from '../core/policy.js';

export type ProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
};

export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ToolResult = {
  name: string;
  result: string;
  error?: string;
};

export type ChatRequest = {
  messages: ChatMessage[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDef[];
  /** Called with each streamed text delta (enables SSE streaming) */
  onDelta?: (delta: string) => void;
  /** AbortSignal to cancel the request mid-flight */
  signal?: AbortSignal;
  /** Per-run governance state. Provider adapters must not persist its contents. */
  runtime?: {
    policy?: ResolvedPolicy;
    audit?: AuditSink;
    model?: string;
  };
};

export type ChatResponse = {
  content: string;
  model: string;
  toolCalls?: ToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
};

export interface ProviderAdapter {
  readonly name: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
}
