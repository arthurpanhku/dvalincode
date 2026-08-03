import { describe, expect, it } from 'vitest';
import { formatElapsed } from '../web/src/lib/duration.js';
import { mapBackendMessages } from '../web/src/lib/messages.js';

describe('agent activity duration', () => {
  it('formats elapsed time for the Worked for disclosure', () => {
    expect(formatElapsed(0)).toBe('0 Min 0 S');
    expect(formatElapsed(65_900)).toBe('1 Min 5 S');
    expect(formatElapsed(-100)).toBe('0 Min 0 S');
  });
});

describe('mapBackendMessages recovered turns', () => {
  it('restores recovered notices from session detail projection', () => {
    const messages = mapBackendMessages(
      [
        { role: 'user', content: 'resume now' },
        { role: 'assistant', content: 'ready' },
      ],
      [{ messageId: 'lost-msg-1', content: 'build the dashboard' }],
    );

    expect(messages.at(-1)).toEqual({
      role: 'recovered',
      messageId: 'lost-msg-1',
      content: 'build the dashboard',
    });
  });

  it('does not synthesize a recovered notice when none is projected', () => {
    const messages = mapBackendMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);

    expect(messages.some((message) => message.role === 'recovered')).toBe(false);
  });
});
