import { describe, expect, it } from 'vitest';

import { CLIENT_INFO, PROTOCOL_VERSION } from '../../src/mcp/client.js';
import { VERSION } from '../../src/version.js';

describe('MCP client metadata', () => {
  it('advertises the server protocol ceiling', () => {
    expect(PROTOCOL_VERSION).toBe('2025-11-25');
  });

  it('reports the current DvalinCode version', () => {
    expect(CLIENT_INFO.version).toBe(VERSION);
  });
});
