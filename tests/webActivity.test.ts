import { describe, expect, it } from 'vitest';
import { formatElapsed } from '../web/src/lib/duration.js';

describe('agent activity duration', () => {
  it('formats elapsed time for the Worked for disclosure', () => {
    expect(formatElapsed(0)).toBe('0 Min 0 S');
    expect(formatElapsed(65_900)).toBe('1 Min 5 S');
    expect(formatElapsed(-100)).toBe('0 Min 0 S');
  });
});
