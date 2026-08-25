import { checkCommand, loadPolicy } from '../core/policy.js';
import { runGovernedProcess } from '../core/subprocessSandbox.js';
import { pickProjectCheck, type CheckKind } from '../tools/runCheck.js';
import { sha256 } from '../audit/hash.js';
import type { AuditSink } from '../audit/log.js';
import type { SecurityCheckEvidence } from '../security/workflow.js';

/**
 * Dvalin runs the project's checks itself.
 *
 * Asking the agent that just wrote a patch whether its patch is good is the one
 * question it is least able to answer honestly, and no amount of prompt
 * wording fixes that. Running the commands here means the exit codes in the
 * verification gate are observed, not reported — which is what lets the choice
 * of remediation executor be a question of cost and quality rather than trust.
 */
const DEFAULT_KINDS: CheckKind[] = ['test', 'typecheck', 'build'];

export type VerificationRun = {
  evidence: SecurityCheckEvidence[];
  /** Checks that could not be found in this project, so nothing was run for them. */
  skipped: CheckKind[];
};

export type VerifyOptions = {
  cwd: string;
  /** Explicit commands, for projects whose checks cannot be detected. */
  commands?: string[];
  /** Which project checks to look for. Defaults to test, typecheck, build. */
  kinds?: CheckKind[];
  timeoutMs?: number;
  /**
   * Write each executed check into the hash-chained audit log.
   *
   * Without this the exit codes exist only in memory: the verdict is sound but
   * nothing afterwards can show what was run. A Verified Fix Record anchors to
   * the chain, so the chain has to contain the checks.
   */
  audit?: AuditSink;
};

export async function runProjectVerification(options: VerifyOptions): Promise<VerificationRun> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const policy = loadPolicy(options.cwd).policy;
  const evidence: SecurityCheckEvidence[] = [];
  const skipped: CheckKind[] = [];

  if (options.commands?.length) {
    for (const commandLine of options.commands) {
      evidence.push(await runOne('custom', splitCommand(commandLine), options.cwd, policy, timeoutMs, options.audit));
    }
    return { evidence, skipped };
  }

  // `kinds: []` is a project saying "run no checks", which is different from
  // not asking. It leads to an unverifiable record, which is the honest result.
  for (const kind of options.kinds ?? DEFAULT_KINDS) {
    const picked = await pickProjectCheck(options.cwd, kind, []);
    if (!picked) {
      skipped.push(kind);
      continue;
    }
    evidence.push(await runOne(kind, picked, options.cwd, policy, timeoutMs, options.audit));
  }
  return { evidence, skipped };
}

async function runOne(
  kind: string,
  picked: { command: string; args: string[] },
  cwd: string,
  policy: ReturnType<typeof loadPolicy>['policy'],
  timeoutMs: number,
  audit?: AuditSink,
): Promise<SecurityCheckEvidence> {
  const commandLine = [picked.command, ...picked.args].join(' ');
  try {
    return await execute(kind, picked, commandLine, cwd, policy, timeoutMs, audit);
  } catch (error) {
    // A check that could not be executed did not pass. Letting the throw escape
    // would abandon the remaining checks and lose the verification entirely,
    // when the honest record is simply that this one produced no exit code.
    audit?.append({
      type: 'tool_call',
      tool: 'run_check',
      argsSummary: `${kind}: ${error instanceof Error ? error.message : String(error)}`,
      status: 'error',
      durationMs: 0,
    });
    return { kind, command: commandLine, exitCode: null, passed: false };
  }
}

async function execute(
  kind: string,
  picked: { command: string; args: string[] },
  commandLine: string,
  cwd: string,
  policy: ReturnType<typeof loadPolicy>['policy'],
  timeoutMs: number,
  audit?: AuditSink,
): Promise<SecurityCheckEvidence> {

  // The same gate every other governed command passes. A policy that forbids a
  // command does not get bypassed because the caller is the verifier.
  const decision = checkCommand(policy, commandLine);
  if (!decision.allowed) {
    audit?.append({ type: 'policy_violation', rule: decision.rule ?? 'command denied', tool: 'run_check', target: picked.command });
    return { kind, command: commandLine, exitCode: null, passed: false };
  }

  const startedAt = Date.now();
  const result = await runGovernedProcess({
    command: picked.command,
    args: picked.args,
    cwd,
    timeoutMs,
    policy,
    toolName: 'dvalin_verify',
    preferSandboxWhenUnrestricted: true,
  });

  // Same shape the tool-layer tap emits for `run_check`, so anything already
  // reading the chain for check evidence keeps working.
  audit?.append({
    type: 'tool_call',
    tool: 'run_check',
    argsSummary: kind,
    status: result.exitCode === 0 && !result.timedOut ? 'ok' : 'error',
    durationMs: Date.now() - startedAt,
  });
  audit?.append({
    type: 'shell_exec',
    command: picked.command,
    argsCount: picked.args.length,
    inputHash: sha256(commandLine),
    exitCode: result.exitCode,
    sandbox: result.sandbox === 'seatbelt' || result.sandbox === 'bwrap' ? result.sandbox : 'none',
  });

  return {
    kind,
    command: commandLine,
    exitCode: result.exitCode,
    // A timeout is not a pass, whatever the exit code ends up being.
    passed: result.exitCode === 0 && !result.timedOut,
  };
}

/**
 * Split a configured command into argv.
 *
 * Deliberately not a shell: a check command is a program and its arguments, and
 * running it through a shell would hand the project's own configuration a way
 * to run something else. Quotes are honoured only so an argument may contain a
 * space — `npm test -- --grep "two words"` — and nothing else about them is
 * interpreted.
 */
export function splitCommand(commandLine: string): { command: string; args: string[] } {
  const parts = commandLine.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const argv = parts.map(part =>
    (part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))
      ? part.slice(1, -1)
      : part,
  );
  return { command: argv[0] ?? '', args: argv.slice(1) };
}
