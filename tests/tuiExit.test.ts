import { describe, expect, it } from 'vitest';
import { isExitCommand } from '../src/tui/app.js';

describe('TUI exit commands', () => {
  it('accepts bare and slash exit commands', () => {
    for (const input of ['exit', ' exit ', 'quit', ':q', '/exit', '/quit']) {
      expect(isExitCommand(input)).toBe(true);
    }
  });

  it('does not treat ordinary messages as exit commands', () => {
    for (const input of ['please exit later', '/git', '/help', 'q']) {
      expect(isExitCommand(input)).toBe(false);
    }
  });
});
