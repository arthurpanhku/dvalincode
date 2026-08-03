import { defineConfig } from 'vitest/config';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Route audit-trail writes to a throwaway temp dir during tests so the suite
// (which exercises AgentLoop.processMessage) never pollutes ~/.dvalincode/audit.
const auditDir = mkdtempSync(path.join(tmpdir(), 'dvalin-test-audit-'));

export default defineConfig({
  test: {
    // Scope discovery to the suite itself. Without this, the default glob also
    // walks agent worktrees under .claude/, counting whole copies of the suite
    // again and reporting a test total several times the real one.
    include: ['tests/**/*.test.ts'],
    env: {
      DVALINCODE_AUDIT_DIR: auditDir,
    },
  },
});
