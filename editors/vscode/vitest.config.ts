import { defineConfig } from 'vitest/config';

// Without a config here, vitest walks up and picks the repository root's
// vitest.config.ts, which resolves `vitest` from the root node_modules — absent
// in a CI job that only installs this package.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    root: import.meta.dirname,
  },
});
