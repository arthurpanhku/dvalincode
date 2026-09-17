import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every third-party action in this repository is pinned by commit digest, with
 * a comment above it naming the version that digest belongs to. The digest is
 * what runs; the comment is what a reader trusts. Dependabot moves the former
 * and never the latter, so the two drift apart silently — by the time this test
 * was written, `actions/setup-node` was pinned to v7.0.0 under a comment
 * claiming v6.4.0, and one digest of `softprops/action-gh-release` carried the
 * comment v3.0.1 in two places and v3.0.2 in a third.
 *
 * These assertions are offline, so they cannot confirm a comment against the
 * upstream tag — that needs the network, and a scan here never gets it. What
 * they do catch is the repository contradicting itself: one digest described
 * two ways, or one version resolving to two digests. The latter is the failure
 * behind #126/#127, where codeql-action/init and analyze drifted onto different
 * commits and the analysis step rejected the pair at runtime.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = path.join(repoRoot, '.github', 'workflows');

interface Pin {
  /** `owner/repo` with any subpath stripped — the digest belongs to the repo. */
  repo: string;
  /** The full reference as written, e.g. `github/codeql-action/init`. */
  ref: string;
  digest: string;
  version?: string;
  file: string;
  line: number;
}

/** `uses: owner/repo[/subpath]@<40 hex>`, which is the only form we allow. */
const PINNED = /^\s*(?:-\s*)?uses:\s*([\w.-]+\/[\w.-]+(?:\/[\w./-]+)?)@([0-9a-f]{40})\s*$/;
/** Any `uses:` at all, so an unpinned one is still seen. */
const ANY_USES = /^\s*(?:-\s*)?uses:\s*(\S+)\s*$/;

function sourceFiles(): string[] {
  const workflows = readdirSync(workflowDir)
    .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map(name => path.join(workflowDir, name));
  return [...workflows, path.join(repoRoot, 'action.yml')];
}

/**
 * The version comment sits directly above the `uses:` line, but not always
 * adjacent — release.yml explains why a step re-checks out before the pin. Walk
 * up the contiguous comment block and take the first line that names this
 * action with a version.
 */
function versionAbove(lines: string[], index: number, ref: string): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const text = lines[i].trim();
    if (!text.startsWith('#')) break;
    const match = text.match(new RegExp(`${ref.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s+v(\\S+)`));
    if (match) return match[1];
  }
  return undefined;
}

function collectPins(): { pins: Pin[]; unpinned: string[] } {
  const pins: Pin[] = [];
  const unpinned: string[] = [];

  for (const file of sourceFiles()) {
    const relative = path.relative(repoRoot, file);
    const lines = readFileSync(file, 'utf8').split('\n');

    lines.forEach((line, index) => {
      const pinned = line.match(PINNED);
      if (pinned) {
        const [, ref, digest] = pinned;
        pins.push({
          repo: ref.split('/').slice(0, 2).join('/'),
          ref,
          digest,
          version: versionAbove(lines, index, ref),
          file: relative,
          line: index + 1,
        });
        return;
      }

      const any = line.match(ANY_USES);
      // `./` is this repository's own composite action, which has no digest.
      if (any && !any[1].startsWith('./') && !any[1].startsWith('docker://')) {
        unpinned.push(`${relative}:${index + 1} uses ${any[1]}`);
      }
    });
  }

  return { pins, unpinned };
}

describe('the digests every workflow is pinned to', () => {
  it('finds the pins it means to check', () => {
    // A parser that silently matches nothing would make every other assertion
    // here vacuous, so anchor it: these files do contain pinned actions.
    const { pins } = collectPins();
    expect(pins.length).toBeGreaterThan(10);
  });

  it('pins every third-party action by commit digest, never by tag', () => {
    // A tag is mutable; whoever controls the upstream repository can move it
    // onto different code after review. The digest is the whole point.
    const { unpinned } = collectPins();
    expect(unpinned, `unpinned action references:\n${unpinned.join('\n')}`).toEqual([]);
  });

  it('names a version in a comment above each pin', () => {
    const { pins } = collectPins();
    const undocumented = pins
      .filter(pin => !pin.version)
      .map(pin => `${pin.file}:${pin.line} pins ${pin.ref} with no "# ${pin.ref} vX.Y.Z" above it`);
    expect(undocumented, undocumented.join('\n')).toEqual([]);
  });

  it('describes one digest with one version everywhere it appears', () => {
    // Catches the drift Dependabot leaves behind: it rewrites the digest in
    // every file, so a comment that disagrees with its siblings is one a human
    // edited, or one Dependabot moved past.
    const { pins } = collectPins();
    const versionsByDigest = new Map<string, Map<string, string[]>>();

    for (const pin of pins) {
      if (!pin.version) continue;
      const key = `${pin.repo}@${pin.digest}`;
      const versions = versionsByDigest.get(key) ?? new Map<string, string[]>();
      versions.set(pin.version, [...(versions.get(pin.version) ?? []), `${pin.file}:${pin.line}`]);
      versionsByDigest.set(key, versions);
    }

    const contradictions = [...versionsByDigest.entries()]
      .filter(([, versions]) => versions.size > 1)
      .map(([key, versions]) => {
        const detail = [...versions.entries()]
          .map(([version, sites]) => `    v${version} at ${sites.join(', ')}`)
          .join('\n');
        return `  ${key} is described as ${versions.size} different versions:\n${detail}`;
      });

    expect(contradictions, `\n${contradictions.join('\n')}`).toEqual([]);
  });

  it('resolves one version of one action to one digest', () => {
    // The other direction, and the one that broke CI in #126/#127: coupled
    // actions out of the same repository — codeql-action/init, /analyze and
    // /upload-sarif — must move together. Two digests under one version means
    // a bump landed in some files and not others.
    const { pins } = collectPins();
    const digestsByVersion = new Map<string, Map<string, string[]>>();

    for (const pin of pins) {
      if (!pin.version) continue;
      const key = `${pin.repo} v${pin.version}`;
      const digests = digestsByVersion.get(key) ?? new Map<string, string[]>();
      digests.set(pin.digest, [...(digests.get(pin.digest) ?? []), `${pin.file}:${pin.line}`]);
      digestsByVersion.set(key, digests);
    }

    const split = [...digestsByVersion.entries()]
      .filter(([, digests]) => digests.size > 1)
      .map(([key, digests]) => {
        const detail = [...digests.entries()]
          .map(([digest, sites]) => `    ${digest.slice(0, 12)} at ${sites.join(', ')}`)
          .join('\n');
        return `  ${key} resolves to ${digests.size} different digests:\n${detail}`;
      });

    expect(split, `\n${split.join('\n')}`).toEqual([]);
  });

  it('keeps the codeql-action steps on a single digest', () => {
    // action.yml ships upload-sarif to every consumer of the Dvalin action,
    // and this repository's own workflows run init and analyze. They are one
    // upstream release: the analysis rejects a mismatched init at runtime.
    const { pins } = collectPins();
    const codeql = pins.filter(pin => pin.repo === 'github/codeql-action');

    expect(codeql.length, 'codeql-action is referenced in action.yml and the workflows').toBeGreaterThan(2);
    expect(new Set(codeql.map(pin => pin.digest)).size).toBe(1);
    expect(new Set(codeql.map(pin => pin.version)).size).toBe(1);
  });
});
