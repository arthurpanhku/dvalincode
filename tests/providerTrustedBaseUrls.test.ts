import { describe, expect, it } from 'vitest';
import { requireTrustedProviderBaseUrl } from '../src/providers/trustedBaseUrls.js';

describe('the cc-switch provider', () => {
  /**
   * CC Switch's local routing listens on 127.0.0.1:15721 unless changed in its
   * settings. Port 3456 belongs to claude-code-router, which is what the generic
   * `gateway` preset still points at.
   */
  it("defaults to CC Switch's local routing address", () => {
    expect(requireTrustedProviderBaseUrl('cc-switch', undefined)).toBe('http://127.0.0.1:15721/v1');
    expect(requireTrustedProviderBaseUrl('cc-switch', 'http://localhost:15721/v1/')).toBe('http://localhost:15721/v1');
  });

  it('no longer trusts the port that was never CC Switch', () => {
    expect(() => requireTrustedProviderBaseUrl('cc-switch', 'http://localhost:3456/v1'))
      .toThrow(/limited to the trusted cc-switch endpoint/);
    expect(requireTrustedProviderBaseUrl('gateway', 'http://localhost:3456/v1')).toBe('http://localhost:3456/v1');
  });
});
