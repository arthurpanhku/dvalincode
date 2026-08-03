/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Semantic tokens — backed by CSS variables (RGB channels) so the
        // light/dark themes can swap values while keeping Tailwind's opacity
        // modifiers (e.g. bg-accent/90) working via <alpha-value>.
        bg: 'rgb(var(--color-bg) / <alpha-value>)',
        elevated: 'rgb(var(--color-elevated) / <alpha-value>)',
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        'surface-2': 'rgb(var(--color-surface-2) / <alpha-value>)',
        border: 'rgb(var(--color-border) / <alpha-value>)',
        'border-strong': 'rgb(var(--color-border-strong) / <alpha-value>)',
        muted: 'rgb(var(--color-muted) / <alpha-value>)',
        'muted-fg': 'rgb(var(--color-muted-fg) / <alpha-value>)',
        fg: 'rgb(var(--color-fg) / <alpha-value>)',
        'fg-strong': 'rgb(var(--color-fg-strong) / <alpha-value>)',
        accent: 'rgb(var(--color-accent) / <alpha-value>)',
        'tool-bg': 'rgb(var(--color-tool-bg) / <alpha-value>)',
        'success-fg': 'rgb(var(--color-success-fg) / <alpha-value>)',
        'warn-fg': 'rgb(var(--color-warn-fg) / <alpha-value>)',
        'danger-fg': 'rgb(var(--color-danger-fg) / <alpha-value>)',
        'info-fg': 'rgb(var(--color-info-fg) / <alpha-value>)',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'dot-bounce': {
          '0%, 80%, 100%': { transform: 'scale(0.6)', opacity: '0.4' },
          '40%': { transform: 'scale(1)', opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.15s ease-out',
        'dot-1': 'dot-bounce 1.2s infinite 0ms',
        'dot-2': 'dot-bounce 1.2s infinite 150ms',
        'dot-3': 'dot-bounce 1.2s infinite 300ms',
        'slide-up': 'slide-up 0.2s ease-out',
      },
    },
  },
  plugins: [],
};
