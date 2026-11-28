import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: 'class',
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        navy: {
          50: '#F0F3F7',
          100: '#D9DFE8',
          200: '#B3BFD1',
          300: '#8D9FBA',
          400: '#677FA3',
          500: '#455B7A',
          600: '#334562',
          700: '#253549',
          800: '#1B2838',
          900: '#111B27',
          950: '#0A1018',
        },
        teal: {
          50: '#ecfdf5',
          100: '#d1fae5',
          200: '#a7f3d0',
          300: '#6ee7b7',
          400: '#34d399',
          500: '#10b981',
          600: '#059669',
          700: '#047857',
          800: '#065f46',
          900: '#064e3b',
          950: '#022c22',
        },
      },
      // Text only: the light emerald/red shades fail 4.5:1 as text on the light
      // theme, so text-emerald-400/500/600 and text-red-400/500/600 resolve to
      // theme-aware tokens from globals.css (emerald-700/red-700 on light,
      // emerald-400/red-400 on dark). Backgrounds, borders and rings keep the
      // stock palette.
      textColor: {
        emerald: {
          400: 'rgb(var(--primary-text) / <alpha-value>)',
          500: 'rgb(var(--primary-text) / <alpha-value>)',
          600: 'rgb(var(--primary-text) / <alpha-value>)',
        },
        red: {
          400: 'rgb(var(--danger-text) / <alpha-value>)',
          500: 'rgb(var(--danger-text) / <alpha-value>)',
          600: 'rgb(var(--danger-text) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}
export default config
