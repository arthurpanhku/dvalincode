import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildClaudeArgs,
  claudeChildEnv,
  claudeCodeExecutor,
  claudeSandboxSupport,
  parseClaudeStream,
  resolveExecutor,
  type ExecutorEvent,
} from '../src/remediation/executor.js';

/** A `claude -p --output-format stream-json --verbose` stream, in the shape Claude Code 2.1 writes. */
const STREAM = [
  '{"type":"system","subtype":"init","session_id":"5f0c1d2e-0000-4000-8000-000000000001","tools":["Read","Edit","Bash"],"permissionMode":"acceptEdits"}',
  '{"type":"stream_event","event":{"type":"message_start"}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Looking at the finding."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test -- auth\\nsecond line"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"1 failing\\nmore"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"src/auth.js"}}]}}',
  '{"type":"result","subtype":"success","is_error":false,"result":"Parameterized the query.","session_id":"5f0c1d2e-0000-4000-8000-000000000001","num_turns":3}',
].join('\n');

describe('parseClaudeStream', () => {
  it('takes the result and the session to resume from the result event', () => {
    expect(parseClaudeStream(STREAM)).toEqual({
      output: 'Parameterized the query.',
      session: '5f0c1d2e-0000-4000-8000-000000000001',
    });
  });

  it('reports a turn that ended in error as an error, not an empty answer', () => {
    const failed = '{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login","session_id":"s"}';
    expect(parseClaudeStream(failed).error).toBe('Invalid API key · Please run /login');
    const capped = '{"type":"result","subtype":"error_max_turns","is_error":false,"session_id":"s"}';
    expect(parseClaudeStream(capped).error).toBe('error_max_turns');
  });

  it('ignores lines that are not events', () => {
    expect(parseClaudeStream(['warning: something', '', STREAM, '[1,2]'].join('\n')).output).toBe('Parameterized the query.');
    expect(parseClaudeStream('')).toEqual({ output: '', session: undefined });
  });
});

describe('the claude command line', () => {
  it('accepts edits and grants the shell only inside the sandbox', () => {
    const args = buildClaudeArgs({ prompt: 'Fix it', cwd: '/w' }, true);
    expect(args.slice(0, 7)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--settings']);
    expect(JSON.parse(args[7]!)).toEqual({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false } });
    expect(args).not.toContain('bypassPermissions');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('takes the shell away when there is no sandbox', () => {
    const args = buildClaudeArgs({ prompt: 'Fix it', cwd: '/w' }, false);
    expect(args).toContain('--disallowedTools');
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Bash');
    expect(args).not.toContain('--settings');
  });

  it('resumes the conversation, and never reads a prompt as a flag', () => {
    const args = buildClaudeArgs({ prompt: '--dangerously-skip-permissions', cwd: '/w', resume: 'abc' }, true);
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', 'abc']);
    expect(args.slice(-2)).toEqual(['--', '--dangerously-skip-permissions']);
  });

  it('starts a fresh session even when Dvalin itself runs inside Claude Code', () => {
    const env = claudeChildEnv({
      CLAUDECODE: '1',
      CLAUDE_PID: '42',
      CLAUDE_CODE_SESSION_ID: 'parent',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_REMOTE_SESSION_ID: 'parent-remote',
      ANTHROPIC_API_KEY: 'kept',
      CLAUDE_CODE_OAUTH_TOKEN: 'kept',
      PATH: '/bin',
    });
    expect(env).toEqual({ ANTHROPIC_API_KEY: 'kept', CLAUDE_CODE_OAUTH_TOKEN: 'kept', PATH: '/bin' });
  });

  it('is found by name', () => {
    expect(resolveExecutor('claude-code')).toBe(claudeCodeExecutor);
  });
});

describe('claudeSandboxSupport', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('has no sandbox on Windows', async () => {
    expect((await claudeSandboxSupport('win32')).available).toBe(false);
  });

  it('needs bubblewrap and socat on Linux', async () => {
    vi.stubEnv('PATH', '');
    expect(await claudeSandboxSupport('linux')).toEqual({ available: false, missing: ['bwrap', 'socat'] });
  });
});

/** Runs a fake `claude` whose behaviour is chosen by FAKE_CLAUDE_MODE. POSIX launcher only. */
describe.skipIf(process.platform === 'win32')('running the executor', () => {
  let bin: string;
  let cwd: string;

  async function executable(name: string, body: string): Promise<void> {
    const file = path.join(bin, name);
    await writeFile(file, body, 'utf8');
    await chmod(file, 0o755);
  }

  beforeEach(async () => {
    bin = await mkdtemp(path.join(tmpdir(), 'dvalin-fake-claude-'));
    cwd = await mkdtemp(path.join(tmpdir(), 'dvalin-claude-cwd-'));
    const script = path.join(bin, 'claude.cjs');
    await writeFile(script, `const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
writeFileSync('claude-args.json', JSON.stringify({ args, sessionEnv: process.env.CLAUDE_CODE_SESSION_ID ?? null }));
const mode = process.env.FAKE_CLAUDE_MODE;
const out = line => process.stdout.write(JSON.stringify(line) + '\\n');
if (mode === 'unsandboxed') {
  process.stderr.write('⚠ Sandbox disabled: dependencies are missing\\n  Commands will run WITHOUT sandboxing.\\n');
  setTimeout(() => { writeFileSync('acted', 'yes'); out({ type: 'result', subtype: 'success', result: 'done', session_id: 's' }); }, 1500);
} else if (mode === 'error') {
  out({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key', session_id: 's' });
  process.exit(1);
} else {
  out({ type: 'system', subtype: 'init', session_id: 'child-1' });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.js' } }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Fixed it.', session_id: 'child-1' });
}
`, 'utf8');
    await executable('claude', `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'parent-session');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(bin, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  async function withSandboxTools(): Promise<void> {
    // On macOS Seatbelt is always there; on Linux, stand in for bwrap and socat.
    await executable('bwrap', '#!/bin/sh\nexit 0\n');
    await executable('socat', '#!/bin/sh\nexit 0\n');
  }

  it('runs a turn, reports its tool calls, and returns the result and session', async () => {
    await withSandboxTools();
    vi.stubEnv('PATH', bin);
    const events: ExecutorEvent[] = [];
    const turn = await claudeCodeExecutor.run({ prompt: 'Fix the finding', cwd }, event => events.push(event));

    expect(turn).toEqual({ output: 'Fixed it.', session: 'child-1' });
    expect(events).toEqual([{ type: 'tool_call', name: 'Edit src/a.js' }]);
    const recorded = JSON.parse(await readFile(path.join(cwd, 'claude-args.json'), 'utf8'));
    expect(recorded.args).toContain('--settings');
    expect(recorded.args.slice(-2)).toEqual(['--', 'Fix the finding']);
    // The parent session's id never reaches the child.
    expect(recorded.sessionEnv).toBeNull();
  });

  it('stops the turn when Claude Code says it is running without its sandbox', async () => {
    await withSandboxTools();
    vi.stubEnv('PATH', bin);
    vi.stubEnv('FAKE_CLAUDE_MODE', 'unsandboxed');

    await expect(claudeCodeExecutor.run({ prompt: 'Fix', cwd })).rejects.toThrow(/without its sandbox/);
    // Killed before it acted.
    await expect(stat(path.join(cwd, 'acted'))).rejects.toThrow();
  });

  it.skipIf(process.platform === 'darwin')('edits only, and says so, when the sandbox is unavailable', async () => {
    vi.stubEnv('PATH', bin);
    const events: ExecutorEvent[] = [];
    await claudeCodeExecutor.run({ prompt: 'Fix', cwd }, event => events.push(event));

    const recorded = JSON.parse(await readFile(path.join(cwd, 'claude-args.json'), 'utf8'));
    expect(recorded.args).toContain('--disallowedTools');
    expect(recorded.args).not.toContain('--settings');
    expect(events[0]).toMatchObject({ type: 'notice', message: expect.stringContaining('edits only') });
  });

  it('fails the turn on an error result', async () => {
    await withSandboxTools();
    vi.stubEnv('PATH', bin);
    vi.stubEnv('FAKE_CLAUDE_MODE', 'error');
    await expect(claudeCodeExecutor.run({ prompt: 'Fix', cwd })).rejects.toThrow('Claude Code failed: Invalid API key');
  });

  it('is unavailable when the CLI is not installed', async () => {
    vi.stubEnv('PATH', '');
    expect(await claudeCodeExecutor.unavailableReason()).toMatch(/not on PATH/);
  });
});
