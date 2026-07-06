import { defineConfig } from 'vitepress'

const GITHUB = 'https://github.com/arthurpanhku/dvalincode'
const HOSTNAME = 'https://dvalincode.dev'

// The site publishes the repo's existing docs/ directory directly — the
// markdown files GitHub renders are the same files dvalincode.dev serves.
export default defineConfig({
  title: 'DvalinCode',
  description:
    'Approvable, local-first AI coding agent for regulated teams — policy-bound, audit-ready, works with any OpenAI-compatible model.',

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
    ['meta', { property: 'og:title', content: 'DvalinCode — the approvable coding agent for regulated teams' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'Policy-bound, audit-ready, local-first AI coding agent. Any OpenAI-compatible model. Controllable · transparent · auditable.',
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
        '可被审批的本地优先 AI 编码代理 — 策略约束、审计就绪，支持任何 OpenAI 兼容模型。',
    },
  },

  themeConfig: {
    // Theme-aware variants generated from assets/logo.png: transparent
    // background; the dark variant inverts the neutral wordmark to white
    // and slightly lifts the brand colors for dark backgrounds.
    logo: { light: '/logo-light.png', dark: '/logo-dark.png' },

    nav: [
      { text: 'Docs', link: '/POLICY-REFERENCE', activeMatch: '^/(?!zh)' },
      { text: 'Roadmap', link: `${GITHUB}/blob/main/ROADMAP.md` },
      { text: 'Releases', link: `${GITHUB}/releases` },
    ],

    sidebar: [
      {
        text: 'Guides',
        items: [
          { text: 'Org Policy Reference', link: '/POLICY-REFERENCE' },
          { text: 'Secure Remediation', link: '/SECURE-REMEDIATION' },
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
          { text: 'ISO/IEC 42001 AIMS', link: '/governance/ISO-42001-AIMS' },
          { text: 'AI Change Impact Assessment', link: '/governance/AI-CHANGE-IMPACT-ASSESSMENT' },
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
