import { describe, expect, it } from 'vitest';
import { orgPolicySchema, resolvePolicy, type OrgPolicyInput } from '../../src/core/policy.js';

/** Copy-paste recipes from docs/POLICY-REFERENCE.md — must stay in sync with the doc. */
const COMPLETE_EXAMPLE = {
  modes: ['chat', 'cowork', 'code'],
  providers: { allow: ['deepseek', 'openai', 'ollama'] },
  models: { allow: ['deepseek-chat', 'gpt-4o-mini', 'qwen2.5-coder'] },
  commands: {
    allow: ['^npm\\b', '^node\\b', '^git\\b', '^pytest\\b'],
    deny: ['^curl\\b', '^wget\\b', '^rm\\b', '^ssh\\b'],
    defaultDeny: false,
  },
  paths: {
    allow: ['src/**', 'tests/**', 'docs/**'],
    deny: ['**/.env*', 'secrets/**', '**/*.pem'],
  },
  tools: { deny: ['memory_import'] },
  mcp: { allow: ['github', 'jira'] },
  network: 'endpoint-only',
  maxToolCalls: 75,
  unattended: { maxPermissionMode: 'auto', maxIterations: 40, maxWallMinutes: 30 },
} satisfies OrgPolicyInput;

const RECIPE_FINANCE_MACHINE = {
  modes: ['chat', 'cowork'],
  providers: { allow: ['openai'] },
  models: { allow: ['gpt-4o-mini'] },
  commands: {
    allow: ['^npm test\\b', '^npm run lint\\b', '^git status\\b', '^git diff\\b'],
    deny: ['^curl\\b', '^wget\\b', '^rm\\b', '^ssh\\b', '^scp\\b'],
    defaultDeny: true,
  },
  paths: {
    allow: ['src/**', 'tests/**', 'docs/**'],
    deny: ['**/.env*', 'secrets/**', '**/*.pem', '**/*.key', 'infra/credentials/**'],
  },
  tools: { deny: ['shell', 'memory_write', 'memory_import', 'delete_file'] },
  mcp: { allow: [] },
  network: 'off',
  maxToolCalls: 25,
} satisfies OrgPolicyInput;

const RECIPE_FINANCE_REPO = {
  modes: ['chat'],
  paths: { deny: ['payments/**', 'compliance/**'] },
} satisfies OrgPolicyInput;

const RECIPE_ENDPOINT_DEFAULT = {
  modes: ['chat', 'cowork', 'code'],
  providers: { allow: ['deepseek', 'openai', 'groq'] },
  commands: { deny: ['^curl\\b', '^wget\\b', '^nc\\b', '^ssh\\b', '^scp\\b'] },
  paths: { deny: ['**/.env*', 'secrets/**', '**/*.pem', '**/*.key'] },
  network: 'endpoint-only',
  maxToolCalls: 100,
} satisfies OrgPolicyInput;

const RECIPE_PERMISSIVE_DEV = {
  commands: { deny: ['^rm -rf\\b'] },
  paths: { deny: ['**/.env', '**/.env.local'] },
  network: 'on',
} satisfies OrgPolicyInput;

describe('POLICY-REFERENCE.md recipes (schema-valid)', () => {
  it('validates the complete example', () => {
    expect(() => orgPolicySchema.parse(COMPLETE_EXAMPLE)).not.toThrow();
  });

  it('validates locked-down finance (machine + repo)', () => {
    expect(() => orgPolicySchema.parse(RECIPE_FINANCE_MACHINE)).not.toThrow();
    expect(() => orgPolicySchema.parse(RECIPE_FINANCE_REPO)).not.toThrow();
  });

  it('validates endpoint-only default', () => {
    expect(() => orgPolicySchema.parse(RECIPE_ENDPOINT_DEFAULT)).not.toThrow();
  });

  it('validates permissive dev', () => {
    expect(() => orgPolicySchema.parse(RECIPE_PERMISSIVE_DEV)).not.toThrow();
  });

  it('finance repo layer narrows machine (does not widen)', () => {
    const effective = resolvePolicy([RECIPE_FINANCE_MACHINE, RECIPE_FINANCE_REPO]);
    expect(effective.modes).toEqual(['chat']);
    expect(effective.network).toBe('off');
    expect(effective.paths.deny).toContain('payments/**');
  });
});
