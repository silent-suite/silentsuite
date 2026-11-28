import localFont from 'next/font/local'

// Inter, kept in the repository (./inter, SIL Open Font License 1.1: ./inter/OFL.txt)
// so that a build downloads nothing. These are the seven subset files that
// next/font/google served for `Inter({ subsets: ['latin'] })`, with the same
// character ranges: a browser fetches a file only when a page uses its characters,
// and only the Latin file is preloaded.

const interCyrillicExt = localFont({
  src: './inter/inter-cyrillic-ext.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-inter-cyrillic-ext',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F' }],
})

const interCyrillic = localFont({
  src: './inter/inter-cyrillic.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-inter-cyrillic',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116' }],
})

const interGreekExt = localFont({
  src: './inter/inter-greek-ext.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-inter-greek-ext',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'U+1F00-1FFF' }],
})

const interGreek = localFont({
  src: './inter/inter-greek.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-inter-greek',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF' }],
})

const interVietnamese = localFont({
  src: './inter/inter-vietnamese.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-inter-vietnamese',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB' }],
})

const interLatinExt = localFont({
  src: './inter/inter-latin-ext.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-inter-latin-ext',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF' }],
})

const interLatin = localFont({
  src: './inter/inter-latin.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-inter-latin',
  preload: true,
  adjustFontFallback: 'Arial',
  declarations: [{ prop: 'unicode-range', value: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD' }],
})

/** Class names that define one CSS variable per subset; tailwind.config.ts lists them as the sans family. */
export const interVariables = [
  interLatin,
  interLatinExt,
  interCyrillic,
  interCyrillicExt,
  interGreek,
  interGreekExt,
  interVietnamese,
].map((font) => font.variable).join(' ')
