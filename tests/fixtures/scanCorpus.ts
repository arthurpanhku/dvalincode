import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Two corpora that pin the builtin scanner against real-world code.
 *
 * They reproduce the patterns measured on two public repositories:
 *
 * - `MATURE_LIBRARY` mirrors what `axios` looks like to the scanner. Everything
 *   here is a false positive the scanner produced on that repository: test
 *   fixtures that read like credentials, DOM teardown in a test harness, and a
 *   vendored third-party file whose name evades the `**\/*.min.js` ignore.
 *   A well-audited library must scan silent.
 *
 * - `VULNERABLE_APP` mirrors OWASP NodeGoat: genuinely exploitable sinks that
 *   the scanner must report, alongside the same vendored noise it must not.
 *
 * Files are written at run time rather than committed as fixtures so this
 * repository's own scanners have nothing to flag. The `// scanner fixture`
 * markers keep the *source* lines below out of the builtin scanner too — see
 * `isLikelyPlaceholder` in src/remediation/localScan.ts.
 */
export type CorpusFile = { path: string; content: string };

/** A well-audited library. Every line here has been a false positive. */
export const MATURE_LIBRARY: CorpusFile[] = [
  {
    path: 'src/core/dispatchRequest.js',
    content: [
      'export function dispatchRequest(config) {',
      '  return config.adapter(config);',
      '}',
      '',
    ].join('\n'),
  },
  {
    // Credentials in a test are fixtures, not secrets. The value deliberately
    // avoids the words `isLikelyPlaceholder` already knows about, because that
    // is exactly how the real ones slipped through.
    path: 'test/unit/auth.test.js',
    content: [
      "import { describe, it } from 'vitest';",
      '',
      "describe('auth', () => {",
      "  it('sends basic auth', async () => {",
      '    await request({',
      '      auth: {',
      "        username: 'janedoe',", // scanner fixture
      "        password: 'correcthorsebatterystaple',", // scanner fixture
      '      },',
      '    });',
      '  });',
      '});',
      '',
    ].join('\n'),
  },
  {
    // The same fixture repeated across module formats and smoke suites. The
    // repetition is the point: false positives scale with how thoroughly a
    // project tests itself, which is backwards.
    path: 'test/smoke/esm/auth.smoke.test.js',
    content: [
      'const response = await requestWithConfig({',
      '  auth: {',
      "    username: 'janedoe',", // scanner fixture
      "    password: 'correcthorsebatterystaple',", // scanner fixture
      '  },',
      '});',
      '',
    ].join('\n'),
  },
  {
    path: 'test/module/cjs/cjs-typing.test.cjs',
    content: [
      'const config = {',
      '  withCredentials: true,',
      '  auth: {',
      "    username: 'janedoe',", // scanner fixture
      "    password: 'correcthorsebatterystaple',", // scanner fixture
      '  },',
      '};',
      '',
    ].join('\n'),
  },
  {
    path: 'test/unit/prototypePollution.test.js',
    content: [
      'const session = {',
      "  role: 'viewer',",
      '  isAdmin: false,',
      "  token: 'aaaaaaaabbbbbbbbccccccccdddddddd',", // scanner fixture
      '};',
      '',
    ].join('\n'),
  },
  {
    // Clearing the DOM between tests is teardown, not an XSS sink.
    path: 'test/setup/browser.setup.js',
    content: [
      "import { afterEach } from 'vitest';",
      '',
      'afterEach(() => {',
      "  document.body.innerHTML = '';", // scanner fixture
      '});',
      '',
    ].join('\n'),
  },
  {
    // Vendored third-party code. Named `-min` rather than `.min`, so the
    // existing `**/*.min.js` ignore does not cover it.
    path: 'assets/vendor/html5shiv-min.js',
    content: [
      '/*! HTML5 Shiv 3.7.3 | MIT/GPL2 Licensed */',
      'function shivDocument(doc) {',
      "  var frag = doc.createElement('div');",
      "  frag.innerHTML = '<x-element></x-element>';", // scanner fixture
      '  return frag;',
      '}',
      '',
    ].join('\n'),
  },
];

/** A deliberately vulnerable application. The real sinks must be reported. */
export const VULNERABLE_APP: CorpusFile[] = [
  {
    // Dynamic evaluation of request input.
    path: 'app/routes/contributions.js',
    content: [
      "router.post('/contributions', (req, res) => {",
      '  const preTax = eval(req.body.preTax);', // scanner fixture
      '  const afterTax = eval(req.body.afterTax);', // scanner fixture
      '  res.json({ preTax, afterTax });',
      '});',
      '',
    ].join('\n'),
  },
  {
    // Server-side JavaScript evaluation in a Mongo query: user input is
    // interpolated straight into `$where`.
    path: 'app/data/allocations-dao.js',
    content: [
      'function search(userId, threshold) {',
      "  return db.collection('allocations').find({", // scanner fixture
      '    $where: `this.userId == ${userId} && this.stocks > ${threshold}`,', // scanner fixture
      '  });',
      '}',
      '',
    ].join('\n'),
  },
  {
    // The same vendored noise as the mature corpus: still not a finding, even
    // in a repository that has real ones.
    path: 'app/assets/vendor/html5shiv-min.js',
    content: [
      '/*! HTML5 Shiv 3.7.3 | MIT/GPL2 Licensed */',
      'function shivDocument(doc) {',
      "  var frag = doc.createElement('div');",
      "  frag.innerHTML = '<x-element></x-element>';", // scanner fixture
      '  return frag;',
      '}',
      '',
    ].join('\n'),
  },
];

export async function materializeCorpus(root: string, corpus: CorpusFile[]): Promise<void> {
  for (const file of corpus) {
    const absolute = path.join(root, file.path);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content, 'utf8');
  }
}
