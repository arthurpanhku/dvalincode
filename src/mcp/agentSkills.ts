import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { VERSION } from '../version.js';

/**
 * The Dvalin security-gate skill, for the coding agents that load skills.
 *
 * An agent skill is a folder holding a SKILL.md, the format Claude Code and
 * Codex both read. It is unrelated to DvalinCode's own JSON skills in
 * src/skills, which only share the word.
 *
 * The two agents get different copies on purpose, each the one its own
 * integration documents. Claude Code gets the standalone skill from
 * integrations/claude-code, copied into a skills folder from the npm package.
 * Codex gets the dvalin-security plugin from integrations/dvalin-security.
 * Codex installs plugins only from a marketplace, and its CLI can add one
 * straight from GitHub, so Codex's own commands fetch the plugin at this
 * release's tag: no checkout, and no hand-written Codex config.
 */
export const SKILL_NAME = 'dvalin-security-scan';

/** Where the standalone skill sits in the package. package.json `files` ships it. */
export const CLAUDE_SKILL_SOURCE = 'integrations/claude-code/skills/dvalin-security-scan/SKILL.md';

/** The skill's SKILL.md under a project root or a home folder; Claude Code reads both. */
export function claudeSkillFile(base: string): string {
  return path.join(base, '.claude', 'skills', SKILL_NAME, 'SKILL.md');
}

/**
 * The standalone skill as this build ships it. Undefined for a build without
 * the file, such as a standalone binary, which carries no package files.
 */
export async function bundledClaudeSkill(): Promise<string | undefined> {
  try {
    // src/mcp and dist/mcp both sit two levels below the package root.
    return await readFile(new URL(`../../${CLAUDE_SKILL_SOURCE}`, import.meta.url), 'utf8');
  } catch {
    return undefined;
  }
}

export const CODEX_PLUGIN = 'dvalin-security@dvalincode-local';

/**
 * Adds the repository's plugin marketplace from GitHub, at this release's tag.
 * The sparse paths limit the checkout to the marketplace and the plugin, so the
 * rest of the repository, test fixtures included, stays off the machine.
 */
export function codexMarketplaceAddArgs(version = VERSION): string[] {
  return [
    'plugin', 'marketplace', 'add', 'arthurpanhku/dvalincode',
    '--ref', `v${version}`,
    '--sparse', '.agents/plugins',
    '--sparse', 'integrations/dvalin-security',
  ];
}

export function codexPluginAddArgs(): string[] {
  return ['plugin', 'add', CODEX_PLUGIN];
}

/** The dvalin-security plugin Codex's config.toml lists, from whichever marketplace. */
export function codexSkillPlugin(toml: string): string | undefined {
  return /^\s*\[\s*plugins\s*\.\s*(["'])(dvalin-security@[^"'\]]+)\1\s*\]/m.exec(toml)?.[2];
}

/** Whether Codex already has the dvalincode-local marketplace, from a checkout or from GitHub. */
export function codexHasMarketplace(toml: string): boolean {
  return /^\s*\[\s*marketplaces\s*\.\s*(?:"dvalincode-local"|'dvalincode-local'|dvalincode-local)\s*\]/m.test(toml);
}
