import { defineConfig } from 'vitepress'

const GITHUB = 'https://github.com/arthurpanhku/dvalincode'
const HOSTNAME = 'https://dvalincode.dev'

// The site publishes the repo's existing docs/ directory directly — the
// markdown files GitHub renders are the same files dvalincode.dev serves.
export default defineConfig({
  title: 'DvalinCode',
  description:
    'Scanners find. Agents fix. Dvalin decides whether the fix is real — and issues a record anyone can re-check offline.',

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
    ['meta', { property: 'og:title', content: 'DvalinCode — Scanners find. Agents fix. Dvalin decides.' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'Your coding agent says it fixed the vulnerability. Dvalin checks with the scanners your CI already runs and your own tests, then issues a record anyone can re-check offline.',
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
        '扫描器找问题，Agent 写修复，Dvalin 判定修复是不是真的 —— 并签发任何人都能离线复验的记录。',
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

    // The Chinese pages are the two product guides, the built-in agent, trust
    // and governance, and the release notes; every other page is English-only,
    // so /zh/ gets a sidebar of its own.
    sidebar: {
      '/zh/': [
        {
          text: '开始使用',
          items: [
            { text: 'CLI', link: '/zh/cli' },
            { text: '桌面应用', link: '/zh/gui' },
            { text: '内置 Agent', link: '/zh/agent' },
            { text: '信任与治理', link: '/zh/trust' },
            { text: '新功能', link: '/zh/whats-new' },
          ],
        },
      ],
      '/': [
        {
          text: 'Get started',
          items: [
            { text: 'CLI', link: '/cli' },
            { text: 'Desktop app', link: '/gui' },
            { text: 'Built-in agent', link: '/agent' },
            { text: "What's new", link: '/whats-new' },
          ],
        },
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
            { text: 'Code signing policy', link: '/CODE-SIGNING' },
            { text: 'Privacy notice', link: '/PRIVACY' },
            { text: 'OpenSSF Scorecard', link: '/security/OPENSSF-SCORECARD' },
          ],
        },
        {
          text: 'Governance',
          items: [
            { text: 'Trust and governance', link: '/trust' },
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
    },

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
