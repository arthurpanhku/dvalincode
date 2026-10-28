import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { pickProjectCheck } from '../tools/runCheck.js';
import type { DvalinScannerId } from '../remediation/scannerSuite.js';
import type { DvalinSecurityConfig } from './config.js';

/**
 * `dvalin init` as one step from "never ran it" to "it gates my merges".
 *
 * Every step a new project has to discover on its own — write a policy, find
 * which checks prove a fix, accept the backlog it already carries, wire up CI —
 * is a step where adoption stops. Init does them, writes nothing it would
 * overwrite, and says what it left for a person.
 */

export type CiProvider = 'github' | 'gitlab';
export const CI_PROVIDERS: readonly CiProvider[] = ['github', 'gitlab'];

const CHECK_KINDS: DvalinSecurityConfig['checks'] = ['test', 'typecheck', 'build', 'lint'];

/**
 * The checks this project actually has. A policy naming a check the project
 * lacks yields records that say the check was skipped, so only what can run is
 * named. With nothing found, `test` stays: a record with no checks is honestly
 * unverifiable, and the policy shows the slot to fill.
 */
export async function detectProjectChecks(root: string): Promise<DvalinSecurityConfig['checks']> {
  const found: DvalinSecurityConfig['checks'] = [];
  for (const kind of CHECK_KINDS) {
    if (await pickProjectCheck(root, kind, [])) found.push(kind);
  }
  return found.length ? found : ['test'];
}

/** Where this repository's merges are gated, from what is already in it. */
export async function detectCiProvider(root: string): Promise<CiProvider | undefined> {
  if (await exists(path.join(root, '.gitlab-ci.yml'))) return 'gitlab';
  if (await exists(path.join(root, '.github'))) return 'github';
  try {
    const config = await readFile(path.join(root, '.git', 'config'), 'utf8');
    if (/url\s*=\s*\S*github\.com[:/]/i.test(config)) return 'github';
    if (/url\s*=\s*\S*gitlab\./i.test(config)) return 'gitlab';
  } catch {
    // Not a git checkout, or a worktree whose config lives elsewhere.
  }
  return undefined;
}

export const CI_TEMPLATE_PATHS: Record<CiProvider, string> = {
  github: '.github/workflows/dvalin.yml',
  // Never `.gitlab-ci.yml` itself: that file is the project's whole pipeline,
  // so ours is a separate file the project includes.
  gitlab: '.gitlab/dvalin-security.yml',
};

export function renderCiTemplate(provider: CiProvider, version: string, scanners: DvalinScannerId[]): string {
  return provider === 'github' ? renderGithubWorkflow(version, scanners) : renderGitlabJob(version);
}

function renderGithubWorkflow(version: string, scanners: DvalinScannerId[]): string {
  return `# Written by \`dvalin init\`. Findings land inline on the pull request diff
# and in the Security tab. No API key, no model, no account.
name: Dvalin security

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  dvalin:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write   # publish findings to code scanning
      pull-requests: write     # the summary comment
    steps:
      - uses: actions/checkout@v5   # pin by commit digest in production
        with:
          fetch-depth: 0            # so the diff can reach the base commit

      - uses: arthurpanhku/dvalincode@v${version}
        with:
          scanners: ${scanners.join(',')}
          fail-on: high
          # Block only what a pull request adds, not the backlog the repository
          # already carried.
          diff: true
          comment: 'true'
`;
}

function renderGitlabJob(version: string): string {
  return `# Written by \`dvalin init\`. Add it to your pipeline from .gitlab-ci.yml:
#
#   include:
#     - local: .gitlab/dvalin-security.yml
#
# The gate is dvalin.security.json: new findings at or above its severity fail
# the job, the committed baseline carries the backlog. Findings appear in the
# merge request's Code Quality widget.
dvalin-security:
  stage: test
  image: node:22-bookworm-slim
  script:
    - npx -y dvalincode@${version} security scan . --sarif dvalin.sarif --gitlab-codequality gl-code-quality-report.json --no-workflow
  artifacts:
    when: always
    reports:
      codequality: gl-code-quality-report.json
    paths:
      - dvalin.sarif
      - gl-code-quality-report.json
`;
}

/** Write a CI template unless something is already there. Returns whether it wrote. */
export async function writeCiTemplate(
  root: string,
  provider: CiProvider,
  version: string,
  scanners: DvalinScannerId[],
  force = false,
): Promise<{ path: string; written: boolean }> {
  const target = path.join(root, CI_TEMPLATE_PATHS[provider]);
  if (!force && await exists(target)) return { path: target, written: false };
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, renderCiTemplate(provider, version, scanners), 'utf8');
  return { path: target, written: true };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
