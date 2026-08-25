import { defineConfig } from 'vitepress'

const GITHUB = 'https://github.com/arthurpanhku/dvalincode'
const HOSTNAME = 'https://dvalincode.dev'

// The site publishes the repo's existing docs/ directory directly — the
// markdown files GitHub renders are the same files dvalincode.dev serves.
export default defineConfig({
  title: 'DvalinCode',
  description:
    'Open, local-first security engineering for human and agent-written code — discover, remediate, verify, and gate with policy-bound evidence.',

  // Internal working notes that live in docs/ but are not public documentation.
  srcExclude: [
    'bugs.md',
    'design.md',
    'legal.md',
    'reference-notes.md',
    'dvalincode-workflow.md',
    'DURABLE-SESSION.md',
    'roadmap.md',
  ],

  cleanUrls: true,
  lastUpdated: true,
  // docs/*.md link to repo files outside docs/ (../README.md, LICENSE, src/…).
  // Those links are valid on GitHub but unresolvable inside the site build.
  ignoreDeadLinks: true,

  sitemap: { hostname: HOSTNAME },

  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/logo.png' }],
    ['meta', { name: 'theme-color', content: '#818cf8' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'DvalinCode' }],
    ['meta', { property: 'og:title', content: 'DvalinCode — open security engineering for human and agent-written code' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'Discover, remediate, verify, and gate human- or agent-written code with a local, policy-bound, audit-ready security runtime.',
      },
    ],
    ['meta', { property: 'og:image', content: `${HOSTNAME}/hero.png` }],
    ['meta', { property: 'og:url', content: HOSTNAME }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    // GoatCounter — cookie-less, GDPR-exempt visit counting. count.js ignores
    // localhost, so dev servers never pollute the stats. The script counts the
    // initial page load; SPA route changes are counted in theme/index.ts.
    [
      'script',
      {
        'data-goatcounter': 'https://dvalincode.goatcounter.com/count',
        async: '',
        src: 'https://gc.zgo.at/count.js',
      },
    ],
  ],

  locales: {
    root: { label: 'English', lang: 'en-US' },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      description:
        '面向人类与 Agent 代码的开放、本地优先安全工程运行时 — 发现、修复、验证与门禁。',
    },
  },

  themeConfig: {
    // Theme-aware variants generated from assets/logo.png: transparent
    // background; the dark variant inverts the neutral wordmark to white
    // and slightly lifts the brand colors for dark backgrounds.
    logo: { light: '/logo-light.png', dark: '/logo-dark.png' },

    nav: [
      { text: 'Docs', link: '/POLICY-REFERENCE', activeMatch: '^/(?!zh|blog)' },
      { text: 'Blog', link: '/blog/', activeMatch: '^/blog' },
      { text: 'Roadmap', link: `${GITHUB}/blob/main/ROADMAP.md` },
      { text: 'Releases', link: `${GITHUB}/releases` },
    ],

    sidebar: [
      {
        text: 'Guides',
        items: [
          { text: 'Org Policy Reference', link: '/POLICY-REFERENCE' },
          { text: 'Secure Remediation', link: '/SECURE-REMEDIATION' },
          { text: 'Security Agent Strategy', link: '/SECURITY-AGENT-STRATEGY' },
          { text: 'Skills', link: '/SKILLS' },
          { text: 'Governed MCP', link: '/GOVERNED-MCP' },
        ],
      },
      {
        text: 'Security',
        items: [
          { text: 'Threat Model', link: '/THREAT-MODEL' },
          { text: 'Egress Threat Model', link: '/EGRESS-THREAT-MODEL' },
          { text: 'Audit Trail', link: '/AUDIT-TRAIL' },
          { text: 'OpenSSF Scorecard', link: '/security/OPENSSF-SCORECARD' },
        ],
      },
      {
        text: 'Governance',
        items: [
          { text: 'Approvability Plan', link: '/APPROVABILITY-PLAN' },
          { text: 'Evidence Pack', link: '/EVIDENCE-PACK' },
          { text: 'Release Evidence Pack', link: '/RELEASE-EVIDENCE' },
          { text: 'ISO/IEC 42001 AIMS', link: '/governance/ISO-42001-AIMS' },
          { text: 'AI Change Impact Assessment', link: '/governance/AI-CHANGE-IMPACT-ASSESSMENT' },
        ],
      },
      {
        text: 'Open specs',
        items: [
          { text: 'Provider Conformance (PCP-1)', link: '/spec/PROVIDER-CONFORMANCE' },
          { text: 'Fix Verification (FVP-1)', link: '/spec/FIX-VERIFICATION' },
        ],
      },
      {
        text: 'Blog',
        items: [
          { text: 'All posts', link: '/blog/' },
          { text: 'Enforced vs advisory', link: '/blog/enforced-vs-advisory' },
        ],
      },
      {
        text: 'About',
        items: [{ text: 'References & Attribution', link: '/REFERENCES' }],
      },
    ],

    socialLinks: [{ icon: 'github', link: GITHUB }],

    search: { provider: 'local' },

    editLink: {
      pattern: `${GITHUB}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License. Not affiliated with any AI vendor.',
      copyright: `© ${new Date().getFullYear()} DvalinCode contributors`,
    },
  },
})
