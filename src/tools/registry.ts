import { assertToolPermission } from '../core/permissions.js';
import { randomUUID } from 'node:crypto';
import { checkTool, checkCommand, checkPath, PolicyViolationError } from '../core/policy.js';
import type { DvalinContext } from '../core/context.js';
import { emitToolAudit } from '../audit/taps.js';
import { minimizedDescriptor } from '../audit/minimize.js';
import { editFileTool } from './editFile.js';
import { gitDiffTool } from './gitDiff.js';
import { listFilesTool } from './listFiles.js';
import { memoryDeleteTool } from './memoryDelete.js';
import { memoryImportTool } from './memoryImport.js';
import { memorySearchTool } from './memorySearch.js';
import { memoryUpdateTool } from './memoryUpdate.js';
import { memoryWriteTool } from './memoryWrite.js';
import { listRemediationCasesTool } from './listRemediationCases.js';
import { listSkillsTool } from './listSkills.js';
import { prepareRemediationWorktreeTool } from './prepareRemediationWorktree.js';
import { projectScriptsTool } from './projectScripts.js';
import { readFileTool } from './readFile.js';
import { readSkillTool } from './readSkill.js';
import { runSecurityScanTool } from './runSecurityScan.js';
import { runSecuritySuiteTool } from './runSecuritySuite.js';
import { runCheckTool } from './runCheck.js';
import { searchTextTool } from './searchText.js';
import { shellTool } from './shell.js';
import { writeFileTool } from './writeFile.js';
import { deleteFileTool } from './deleteFile.js';
import { gitStatusTool } from './gitStatus.js';
import type { Tool, ToolResult } from './types.js';

/**
 * The JSON Schema a caller needs to build a valid input for this tool.
 *
 * Prefer the pre-computed schema — MCP-backed tools carry their own server's
 * native one — and fall back to deriving it from the zod type. Shared so the
 * agent loop, the runner, and `dvalincode tools --json` cannot drift: an agent
 * that reads the CLI's schema must get exactly what the model is given.
 */
export function toolParametersSchema(tool: Tool<unknown>): Record<string, unknown> {
  return tool.parametersSchema ?? tool.inputSchema.toJSONSchema?.() ?? {};
}

export type TruncatedToolOutput = {
  output: string;
  truncated: boolean;
  omittedBytes: number;
};

/**
 * Bound model-visible tool output without splitting UTF-8 characters. Both
 * ends are kept: test and build logs put the failure summary last.
 */
export function truncateToolOutput(output: string, maxBytes: number): TruncatedToolOutput {
  maxBytes = Math.max(0, Math.floor(maxBytes));
  const totalBytes = Buffer.byteLength(output, 'utf8');
  if (totalBytes <= maxBytes) return { output, truncated: false, omittedBytes: 0 };

  // Preserve the hard byte contract even for deliberately tiny test/eval
  // limits where the normal explanatory footer would not fit.
  if (maxBytes < 80) {
    const marker = '[tool output truncated]'.slice(0, maxBytes);
    return { output: marker, truncated: true, omittedBytes: totalBytes };
  }

  const markerBudget = 80;
  const contentBudget = Math.max(0, maxBytes - markerBudget);
  const headBudget = Math.ceil(contentBudget / 2);
  const head = output.slice(0, longestPrefixWithin(output, headBudget));
  const tail = output.slice(earliestSuffixWithin(output, contentBudget - headBudget, head.length));
  const omittedBytes = totalBytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8');
  const marker = `\n[tool output truncated; ${omittedBytes} bytes omitted]\n`;
  return { output: `${head}${marker}${tail}`, truncated: true, omittedBytes };
}

function longestPrefixWithin(text: string, maxBytes: number): number {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return low;
}

function earliestSuffixWithin(text: string, maxBytes: number, minStart: number): number {
  let low = minStart;
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (Buffer.byteLength(text.slice(mid), 'utf8') <= maxBytes) high = mid;
    else low = mid + 1;
  }
  return low;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<unknown>>();
  private allowedToolNames: Set<string> | null = null;

  /** Restrict which tools are visible / executable. Pass null to allow all. */
  setAllowedTools(names: string[] | null): void {
    this.allowedToolNames = names ? new Set(names) : null;
  }

  register<Input>(tool: Tool<Input>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

    this.tools.set(tool.name, tool as Tool<unknown>);
  }

  list(): Tool<unknown>[] {
    const all = [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
    return this.allowedToolNames ? all.filter(t => this.allowedToolNames!.has(t.name)) : all;
  }

  get(name: string): Tool<unknown> | undefined {
    if (this.allowedToolNames && !this.allowedToolNames.has(name)) return undefined;
    return this.tools.get(name);
  }

  async run(name: string, rawInput: unknown, context: DvalinContext): Promise<ToolResult> {
    const tool = this.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    // Org policy — tool-level denylist (before any side effect or permission check).
    const toolDecision = checkTool(context.policy, name);
    if (!toolDecision.allowed) {
      this.denyByPolicy(context, name, toolDecision.rule, name);
    }

    assertToolPermission(tool.access, context);
    const input = tool.inputSchema.parse(rawInput);

    // Org policy — per-target command/path checks, evaluated before the tool runs.
    for (const target of tool.policyTargets?.(input) ?? []) {
      const decision =
        target.kind === 'command' ? checkCommand(context.policy, target.value) : checkPath(context.policy, target.value);
      if (!decision.allowed) {
        this.denyByPolicy(
          context,
          name,
          decision.rule,
          target.value,
          target.kind === 'command' ? minimizedDescriptor(target.value) : target.value,
        );
      }
    }

    // In auto-edit mode every non-read tool requires explicit user approval
    if (context.approvalMode === 'auto-edit' && tool.access !== 'read' && context.requestApproval) {
      const approvalId = `apv_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const approved = await context.requestApproval(approvalId, name, input);
      context.audit?.append({ type: 'approval', toolName: name, approved });
      if (!approved) {
        throw new Error(`User rejected: ${name}`);
      }
    }

    // Audit tap: time the call, emit tool_call + a derived file_*/shell_exec event.
    // All taps are no-ops when no audit sink is attached to the context.
    const started = Date.now();
    try {
      const result = await tool.run(input, context);
      emitToolAudit(context, tool.access, name, input, result, 'ok', Date.now() - started);
      return result;
    } catch (err) {
      emitToolAudit(context, tool.access, name, input, undefined, 'error', Date.now() - started);
      throw err;
    }
  }

  /** Record a policy denial in the audit trail and throw a structured error. */
  private denyByPolicy(
    context: DvalinContext,
    tool: string,
    rule: string,
    target: string,
    auditTarget: string = target,
  ): never {
    context.audit?.append({ type: 'policy_violation', rule, tool, target: auditTarget });
    throw new PolicyViolationError(tool, rule, target);
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(editFileTool);
  registry.register(gitDiffTool);
  registry.register(gitStatusTool);
  registry.register(listFilesTool);
  registry.register(listRemediationCasesTool);
  registry.register(listSkillsTool);
  registry.register(memoryDeleteTool);
  registry.register(memoryImportTool);
  registry.register(memorySearchTool);
  registry.register(memoryUpdateTool);
  registry.register(memoryWriteTool);
  registry.register(prepareRemediationWorktreeTool);
  registry.register(projectScriptsTool);
  registry.register(readFileTool);
  registry.register(readSkillTool);
  registry.register(runCheckTool);
  registry.register(runSecurityScanTool);
  registry.register(runSecuritySuiteTool);
  registry.register(searchTextTool);
  registry.register(shellTool);
  registry.register(writeFileTool);
  registry.register(deleteFileTool);
  return registry;
}
