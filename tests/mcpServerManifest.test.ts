import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

/**
 * `server.json` is the MCP registry listing, and the registry validates it only
 * after the release has otherwise shipped — after npm, after the GitHub Release.
 * `release.yml` therefore checks by hand what the registry checks, but it never
 * validated the schema, which is how the manifest came to declare the
 * 2025-07-09 schema while using the newer `registryType` / `runtimeArguments`
 * field names. Anyone validating it against its own declared schema got two
 * errors that had nothing to do with the file being wrong.
 *
 * These run on every pull request, offline, against a vendored copy of the
 * schema — the release path gains no network dependency and no unpinned tool.
 *
 * The vendored copy is `tests/fixtures/mcp-server.schema.json`, fetched
 * verbatim from the URL in its own `$id`. To move to a newer schema: replace
 * that file and update `$schema` in `server.json`. Doing only one of the two
 * fails the first test below, which is the drift this exists to prevent.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relative: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(repoRoot, relative), 'utf8'));
}

const manifest = readJson('server.json');
const packageJson = readJson('package.json');
const schema = readJson('tests/fixtures/mcp-server.schema.json');

// ajv ships CJS; under ESM the callable lands on `.default`.
const AjvCtor = ((Ajv as any).default ?? Ajv) as typeof Ajv;
const applyFormats = ((addFormats as any).default ?? addFormats) as typeof addFormats;

/** The dated segment of a schema URL — the part that differs when the two drift. */
function schemaVersionOf(url: string): string {
  return /\/schemas\/([^/]+)\//.exec(url)?.[1] ?? url;
}

function validateManifest(document: unknown): { valid: boolean; errors: string[] } {
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  applyFormats(ajv);
  const validate = ajv.compile(schema);
  const valid = validate(document) as boolean;
  return {
    valid,
    errors: (validate.errors ?? []).map(error => `${error.instancePath || '<root>'} ${error.message}`),
  };
}

describe('the MCP registry manifest', () => {
  it('declares the schema version vendored beside this test', () => {
    // The pair that silently disagreed. `$id` is the schema's own statement of
    // which version it is, so neither side can drift without failing here.
    // Compared by version first: both URLs share a long prefix, and asserting
    // on the whole string reports two truncated, identical-looking values.
    expect(schemaVersionOf(manifest.$schema)).toBe(schemaVersionOf(schema.$id));
    expect(manifest.$schema).toBe(schema.$id);
  });

  it('validates against that schema', () => {
    const { valid, errors } = validateManifest(manifest);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it('rejects the field naming that the older schema required', () => {
    // The concrete regression: `registry_type` is what 2025-07-09 wanted, and
    // silently accepting it again would put the manifest back out of step.
    const older = structuredClone(manifest);
    delete older.packages[0].registryType;
    older.packages[0].registry_type = 'npm';

    const { valid, errors } = validateManifest(older);
    expect(valid).toBe(false);
    expect(errors.join(' ')).toContain('registryType');
  });

  it('catches a description over the registry limit, which used to reach the registry', () => {
    // `release.yml` checks this by hand because the registry answers with a 422
    // after auth, after npm, after the GitHub Release. The schema already says
    // maxLength 100, so validating against it covers the same ground earlier.
    const wordy = { ...manifest, description: 'x'.repeat(101) };

    const { valid, errors } = validateManifest(wordy);
    expect(valid).toBe(false);
    expect(errors.join(' ')).toContain('100 characters');
  });

  it('advertises the version the package actually publishes', () => {
    // release.yml compares all three against the git tag. A tag does not exist
    // at pull-request time, but their agreement with each other does.
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.packages[0].version).toBe(packageJson.version);
  });

  it('carries the mcpName the registry proves ownership with', () => {
    // The registry rejects a listing whose npm package lacks a matching
    // mcpName, and only says so after authenticating.
    expect(packageJson.mcpName).toBe(manifest.name);
  });
});
