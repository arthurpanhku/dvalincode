import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import { h } from 'vue'

declare global {
  interface Window {
    goatcounter?: { count: (opts?: { path?: string }) => void }
  }
}

const GITHUB = 'https://github.com/arthurpanhku/dvalincode'

// Trust bar — verifiable signals rendered right under the hero actions. For a
// tool whose pitch is "evidence, not claims", the landing page leads with the
// same badges a reviewer would check: release, adoption, tests, license, and
// the OpenSSF Scorecard.
const BADGES: Array<{ href: string; src: string; alt: string }> = [
  {
    href: `${GITHUB}/releases/latest`,
    src: 'https://img.shields.io/github/v/release/arthurpanhku/dvalincode?color=818cf8&label=Release',
    alt: 'Latest release',
  },
  {
    href: `${GITHUB}/releases`,
    src: 'https://img.shields.io/github/downloads/arthurpanhku/dvalincode/total?color=blue&label=Downloads',
    alt: 'Total downloads',
  },
  {
    href: GITHUB,
    src: 'https://img.shields.io/github/stars/arthurpanhku/dvalincode?color=eac54f&label=Stars',
    alt: 'GitHub stars',
  },
  {
    href: 'https://scorecard.dev/viewer/?uri=github.com/arthurpanhku/dvalincode',
    src: 'https://api.scorecard.dev/projects/github.com/arthurpanhku/dvalincode/badge',
    alt: 'OpenSSF Scorecard',
  },
  {
    href: `${GITHUB}/blob/main/LICENSE`,
    src: 'https://img.shields.io/badge/License-MIT-green',
    alt: 'MIT license',
  },
  {
    href: `${GITHUB}/actions`,
    src: 'https://img.shields.io/badge/runtime_deps-9-success',
    alt: 'Nine runtime dependencies',
  },
]

function TrustBar() {
  return h(
    'div',
    {
      style:
        'display:flex;flex-wrap:wrap;gap:8px;margin-top:20px;align-items:center;',
    },
    BADGES.map(b =>
      h(
        'a',
        { href: b.href, target: '_blank', rel: 'noreferrer' },
        h('img', { src: b.src, alt: b.alt, style: 'height:20px;display:block;' }),
      ),
    ),
  )
}

// GoatCounter's count.js only sees the initial page load (config.ts head
// script). VitePress navigates client-side after that, so each route change
// must be counted explicitly.
export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'home-hero-actions-after': () => TrustBar(),
    }),
  enhanceApp({ router }) {
    if (typeof window === 'undefined') return
    router.onAfterRouteChanged = (to) => {
      window.goatcounter?.count({ path: to })
    }
  },
} satisfies Theme
