import { describe, expect, it } from 'vitest';
import {
  mapBackendMessages,
  withRecoveredNotices,
  withoutRecoveredNotice,
} from '../web/src/lib/messages.js';
import type { ChatMessage } from '../web/src/types.js';

/**
 * Restoring a session in the web UI. The recovered notice used to be built only
 * from the live `recovered_turn` event, so a reload before re-sending lost both
 * the notice and the text of the interrupted turn (#120). These cover the
 * mapping that puts it back.
 */

const recoveredOf = (messages: ChatMessage[]) =>
  messages.filter((m): m is Extract<ChatMessage, { role: 'recovered' }> => m.role === 'recovered');

describe('restoring a session with an interrupted turn', () => {
  it('re-renders a notice the snapshot alone cannot describe', () => {
    const messages = mapBackendMessages([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ]);
    const restored = withRecoveredNotices(messages, [{ messageId: 'm1', content: 'the lost message' }]);

    expect(restored).toHaveLength(3);
    expect(restored.at(-1)).toEqual({ role: 'recovered', messageId: 'm1', content: 'the lost message' });
  });

  it('leaves a clean session untouched', () => {
    const messages = mapBackendMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    // Both an empty list and an older server that sends no field at all.
    expect(withRecoveredNotices(messages, [])).toBe(messages);
    expect(withRecoveredNotices(messages, undefined)).toBe(messages);
    expect(recoveredOf(withRecoveredNotices(messages, []))).toEqual([]);
  });

  it('does not stack a second notice on one already showing', () => {
    // The live event arrives, then the session is re-fetched after a replay:
    // the same turn must not be announced twice.
    const live = withRecoveredNotices([], [{ messageId: 'm1', content: 'lost' }]);
    const again = withRecoveredNotices(live, [{ messageId: 'm1', content: 'lost' }]);
    expect(recoveredOf(again)).toHaveLength(1);
  });

  it('restores every unresolved turn, keeping journal order', () => {
    const restored = withRecoveredNotices([], [
      { messageId: 'm1', content: 'first lost' },
      { messageId: 'm2', content: 'second lost' },
    ]);
    expect(recoveredOf(restored).map((m) => m.messageId)).toEqual(['m1', 'm2']);
  });

  it('drops the notice the re-send took over, and only that one', () => {
    const restored = withRecoveredNotices([], [
      { messageId: 'm1', content: 'first lost' },
      { messageId: 'm2', content: 'second lost' },
    ]);
    const after = withoutRecoveredNotice(restored, 'm1');
    expect(recoveredOf(after).map((m) => m.messageId)).toEqual(['m2']);
  });

  it('keeps the messageId a re-send needs to resolve the turn', () => {
    // The button passes this straight back to send(), which reuses it as the
    // turn's messageId — that is what closes the journal entry rather than
    // opening a second one beside it.
    const [notice] = recoveredOf(withRecoveredNotices([], [{ messageId: 'm1', content: 'lost' }]));
    expect(notice.messageId).toBe('m1');
    expect(notice.content).toBe('lost');
  });

  it('still maps an ordinary conversation the same way', () => {
    // withRecoveredNotices sits on top of the existing mapper; guard that
    // pulling it out of the hook did not change what the mapper produces.
    const messages = mapBackendMessages([
      { role: 'system', content: 'ignored' },
      { role: 'user', content: 'run the scan' },
      {
        role: 'assistant',
        content: 'scanning',
        tool_calls: [{ id: 'tc1', name: 'scan', arguments: '{"path":"."}' }],
      },
      { role: 'tool', tool_call_id: 'tc1', name: 'scan', content: '[Tool scan result]:\nclean' },
    ]);

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const assistant = messages[1] as Extract<ChatMessage, { role: 'assistant' }>;
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls[0]).toMatchObject({ id: 'tc1', name: 'scan', output: 'clean', status: 'done' });
  });
});
