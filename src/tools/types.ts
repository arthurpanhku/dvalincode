import type { z } from 'zod';
import type { DvalinContext } from '../core/context.js';

export type ToolAccess = 'read' | 'write' | 'execute';

/**
 * A policy-relevant aspect of a tool call, surfaced for org-policy enforcement
 * (see src/core/policy.ts). A tool declares its targets so the registry can check
 * them against the resolved policy at one chokepoint — without the registry needing
 * to know each tool's input shape.
 */
export type PolicyTarget =
  | { kind: 'command'; value: string }
  | { kind: 'path'; value: string };

export type ToolResult = {
  title: string;
  output: string;
  metadata?: Record<string, unknown>;
};

export type Tool<Input> = {
  name: string;
  description: string;
  access: ToolAccess;
  inputSchema: z.ZodType<Input>;
  isConcurrencySafe?: (input: Input) => boolean;
  run(input: Input, context: DvalinContext): Promise<ToolResult>;

  /**
   * Policy-relevant targets of this call (commands run, paths touched), checked
   * against the org policy before the tool runs. Omit when the tool has none.
   */
  policyTargets?: (input: Input) => PolicyTarget[];

  /** Whether this tool can be undone. If false, undo is not supported. */
  isUndoable?: (input: Input) => boolean;

  /**
   * Compute the reverse operation input for an undo.
   * Returns the input that would reverse the effect (e.g., swap old/new strings).
   * If undo is not possible after the fact, return undefined.
   * Called only if isUndoable() returned true.
   */
  reverse?: (input: Input, result: ToolResult) => ReverseOp | undefined;
};

export type ReverseOp = {
  /** Tool name to run for the reversal (usually same tool) */
  toolName: string;
  /** Input for the reverse tool call */
  input: unknown;
  /** Human-readable description of the undo action */
  description: string;
};

