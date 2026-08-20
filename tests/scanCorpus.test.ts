import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDvalinScanSuite } from '../src/remediation/scannerSuite.js';
import { MATURE_LIBRARY, VULNERABLE_APP, materializeCorpus } from './fixtures/scanCorpus.js';

const ROOT_PREFIX = 'dvalin-scan-corpus-';

/** Only the builtin scanner: the external ones are absent on most machines. */
const corpusScan = (root: string) => runDvalinScanSuite(root, { scanners: ['builtin'] });

/**
 * Acceptance criteria for the builtin scanner, measured against the shape of
 * real repositories rather than hand-picked one-liners.
 *
 * The bar is not "does it match a regex" but "would a developer trust this":
 * a well-audited library must scan silent, a deliberately vulnerable app must
 * not, and the score must be able to tell the two apart.
 */
describe('builtin scanner, against real-world code shapes', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), ROOT_PREFIX));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  describe('a well-audited library scans silent', () => {
    beforeEach(async () => {
      await materializeCorpus(cwd, MATURE_LIBRARY);
    });

    it('reports nothing at all', async () => {
      const result = await corpusScan(cwd);

      expect(result.findings.map(finding => `${finding.ruleId} ${finding.path}:${finding.startLine}`)).toEqual([]);
    });

    it('grades it A', async () => {
      const result = await corpusScan(cwd);

      expect(result.score).toBe(100);
      expect(result.grade).toBe('A');
    });

    it('does not read test credentials as secrets', async () => {
      const result = await corpusScan(cwd);

      expect(result.findings.filter(finding => finding.path.startsWith('test/'))).toEqual([]);
    });

    it('does not read DOM teardown in a test harness as an XSS sink', async () => {
      const result = await corpusScan(cwd);

      expect(result.findings.filter(finding => finding.ruleId === 'dvalin/dom-html-injection')).toEqual([]);
    });

    it('does not scan vendored third-party code', async () => {
      const result = await corpusScan(cwd);

      expect(result.findings.filter(finding => finding.path.includes('vendor/'))).toEqual([]);
    });
  });

  describe('a deliberately vulnerable app does not', () => {
    beforeEach(async () => {
      await materializeCorpus(cwd, VULNERABLE_APP);
    });

    it('reports evaluation of request input', async () => {
      const result = await corpusScan(cwd);

      expect(result.findings.map(finding => finding.ruleId)).toContain('dvalin/eval');
    });

    it('reports NoSQL injection through an interpolated $where', async () => {
      const result = await corpusScan(cwd);

      const nosql = result.findings.filter(finding => finding.ruleId === 'dvalin/nosql-injection');
      expect(nosql.map(finding => finding.path)).toEqual(['app/data/allocations-dao.js']);
    });

    it('still does not scan vendored third-party code', async () => {
      const result = await corpusScan(cwd);

      expect(result.findings.filter(finding => finding.path.includes('vendor/'))).toEqual([]);
    });

    it('grades it F', async () => {
      const result = await corpusScan(cwd);

      expect(result.grade).toBe('F');
    });
  });

  /**
   * The invariant the score exists to satisfy. Measured before this suite
   * landed, the builtin scanner scored axios 11/100 and NodeGoat 37/100 — the
   * deliberately vulnerable app scored three times better than the audited
   * library, which makes the number worse than no number at all.
   */
  it('scores the vulnerable app below the audited library', async () => {
    const mature = await mkdtemp(path.join(tmpdir(), ROOT_PREFIX));
    const vulnerable = await mkdtemp(path.join(tmpdir(), ROOT_PREFIX));
    try {
      await materializeCorpus(mature, MATURE_LIBRARY);
      await materializeCorpus(vulnerable, VULNERABLE_APP);

      const [matureResult, vulnerableResult] = await Promise.all([
        corpusScan(mature),
        corpusScan(vulnerable),
      ]);

      expect(vulnerableResult.score).toBeLessThan(matureResult.score);
    } finally {
      await rm(mature, { recursive: true, force: true });
      await rm(vulnerable, { recursive: true, force: true });
    }
  });

  it('runs the builtin scanner and nothing else', async () => {
    await materializeCorpus(cwd, MATURE_LIBRARY);

    const result = await runDvalinScanSuite(cwd, { scanners: ['builtin'] });

    expect(result.scanners.map(scanner => scanner.id)).toEqual(['builtin']);
    expect(result.scanners[0].status).toBe('completed');
  });
});
