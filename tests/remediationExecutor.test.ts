import { describe, expect, it } from 'vitest';
import {
  codexExecExecutor,
  dvalinAgentExecutor,
  parseCodexStream,
  resolveExecutor,
} from '../src/remediation/executor.js';

/** A `codex exec --json` stream, in the shape the harness documents. */
const CODEX_STREAM = [
  '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"npm test","status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"npm test","status":"completed","exit_code":0}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Looking at the finding."}}',
  '{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"Fixed the injection."}}',
  '{"type":"turn.completed","usage":{"input_tokens":24763,"output_tokens":122}}',
].join('\n');

describe('parseCodexStream', () => {
  it('takes the thread id as the handle for continuing the conversation', () => {
    expect(parseCodexStream(CODEX_STREAM).session).toBe('0199a213-81c0-7800-8aa1-bbab2a035a53');
  });

  it('takes the last agent message as the result, not the first', () => {
    expect(parseCodexStream(CODEX_STREAM).output).toBe('Fixed the injection.');
  });

  it('ignores anything on the stream that is not an event', () => {
    const stream = ['not json at all', '', CODEX_STREAM, '   '].join('\n');

    expect(parseCodexStream(stream).output).toBe('Fixed the injection.');
  });

  it('returns an empty turn for an empty stream rather than throwing', () => {
    expect(parseCodexStream('')).toEqual({ output: '', session: undefined });
  });
});

describe('resolveExecutor', () => {
  it('defaults to Dvalin and finds Codex by name', () => {
    expect(resolveExecutor('dvalin')).toBe(dvalinAgentExecutor);
    expect(resolveExecutor('codex')).toBe(codexExecExecutor);
  });

  /**
   * The property that makes the choice of executor a cost question rather than
   * a trust question: an executor returns prose and a conversation handle, and
   * nothing it says feeds the verification gate. Dvalin runs the checks itself
   * — see `runProjectVerification`.
   */
  it('exposes no evidence or attestation surface for a caller to trust', () => {
    for (const executor of [dvalinAgentExecutor, codexExecExecutor]) {
      expect(Object.keys(executor).sort()).toEqual(['id', 'name', 'run', 'unavailableReason']);
    }
    expect(Object.keys(parseCodexStream(CODEX_STREAM)).sort()).toEqual(['output', 'session']);
  });
});
