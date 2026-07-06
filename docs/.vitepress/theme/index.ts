import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'

declare global {
  interface Window {
    goatcounter?: { count: (opts?: { path?: string }) => void }
  }
}

// GoatCounter's count.js only sees the initial page load (config.ts head
// script). VitePress navigates client-side after that, so each route change
// must be counted explicitly.
export default {
  extends: DefaultTheme,
  enhanceApp({ router }) {
    if (typeof window === 'undefined') return
    router.onAfterRouteChanged = (to) => {
      window.goatcounter?.count({ path: to })
    }
  },
} satisfies Theme
