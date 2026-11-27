import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHIP_SURFACES, contrastRatio, DARK_TEXT, LIGHT_TEXT, readableTextColor } from '../readable-text-color'

/** Independent alpha blend of #rrggbbaa over an opaque #rrggbb, for checking the picks. */
function blend(color: string, surface: string): string {
  const channels = (hex: string) => [1, 3, 5, 7].map((index) => Number.parseInt(hex.slice(index, index + 2), 16))
  const [r, g, b, a] = channels(color)
  const [sr, sg, sb] = channels(surface)
  const alpha = (a ?? 255) / 255
  return `#${[[r!, sr!], [g!, sg!], [b!, sb!]].map(([c, s]) => Math.round(c * alpha + s * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`
}

describe('readableTextColor', () => {
  it('uses navy text on the default emerald and other light chips', () => {
    expect(readableTextColor('#10b981')).toBe(DARK_TEXT)
    expect(readableTextColor('#3b82f6')).toBe(DARK_TEXT)
    expect(readableTextColor('#f59e0b')).toBe(DARK_TEXT)
    expect(readableTextColor('#fff')).toBe(DARK_TEXT)
  })

  it('keeps white text on dark chips', () => {
    expect(readableTextColor('#047857')).toBe(LIGHT_TEXT)
    expect(readableTextColor('#1e3a8a')).toBe(LIGHT_TEXT)
    expect(readableTextColor('#7c3aed')).toBe(LIGHT_TEXT)
    expect(readableTextColor('#000000ff')).toBe(LIGHT_TEXT)
  })

  it('keeps white text when the colour cannot be parsed', () => {
    expect(readableTextColor('#12345')).toBe(LIGHT_TEXT)
    expect(readableTextColor('teal')).toBe(LIGHT_TEXT)
  })

  it('judges a translucent chip by its composite over each theme surface (review fix 2: WEB-07)', () => {
    // #ffffffcc over the dark page is a light grey (about #cecfd1): navy text, not white.
    expect(readableTextColor('#ffffffcc', CHIP_SURFACES.dark)).toBe(DARK_TEXT)
    // A transparent chip is the page itself: white on the dark page, navy on the light one.
    expect(readableTextColor('#ffffff00', CHIP_SURFACES.dark)).toBe(LIGHT_TEXT)
    expect(readableTextColor('#fff0', CHIP_SURFACES.dark)).toBe(LIGHT_TEXT)
    expect(readableTextColor('#ffffff00', CHIP_SURFACES.light)).toBe(DARK_TEXT)
    for (const [color, surface] of [['#ffffffcc', CHIP_SURFACES.dark], ['#ffffff00', CHIP_SURFACES.dark], ['#ffffff00', CHIP_SURFACES.light], ['#7c3aed80', CHIP_SURFACES.light]] as const) {
      const text = readableTextColor(color, surface)
      const other = text === DARK_TEXT ? LIGHT_TEXT : DARK_TEXT
      expect(contrastRatio(text, blend(color, surface))!, `${color} over ${surface}`).toBeGreaterThan(contrastRatio(other, blend(color, surface))!)
    }
    // An opaque colour decides by itself, whatever the theme.
    for (const surface of [CHIP_SURFACES.light, CHIP_SURFACES.dark]) {
      expect(readableTextColor('#047857', surface)).toBe(LIGHT_TEXT)
      expect(readableTextColor('#10b981ff', surface)).toBe(DARK_TEXT)
    }
  })

  it('keeps its chip surfaces in step with the --background tokens', () => {
    expect(CHIP_SURFACES.light).toBe(tokens(':root').background)
    expect(CHIP_SURFACES.dark).toBe(tokens('.dark').background)
  })

  it('matches WCAG reference ratios', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrastRatio('#ffffff', '#10b981')).toBeCloseTo(2.54, 2)
    expect(contrastRatio('#ffffff', '#047857')).toBeCloseTo(5.48, 2)
  })
})

function tokens(block: ':root' | '.dark'): Record<string, string> {
  const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8')
  const body = css.match(new RegExp(`^${block.replace('.', '\\.')} \\{([^}]*)\\}`, 'm'))?.[1] ?? ''
  const entries = [...body.matchAll(/--([a-z-]+):\s*(\d+) (\d+) (\d+);/g)].map(
    ([, name, r, g, b]) => [name!, `#${[r, g, b].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`],
  )
  return Object.fromEntries(entries)
}

describe('accessible brand tokens in globals.css', () => {
  for (const block of [':root', '.dark'] as const) {
    const t = tokens(block)

    it(`${block}: green and red text reach 4.5:1 on the page and surface`, () => {
      for (const text of ['primary-text', 'danger-text']) {
        for (const bg of ['background', 'surface']) {
          expect(contrastRatio(t[text]!, t[bg]!), `${text} on ${bg}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    })

    it(`${block}: white text on the strong fill reaches 4.5:1 and the fill reaches 3:1 on the page`, () => {
      expect(contrastRatio('#ffffff', t['primary-strong']!)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio('#ffffff', t['primary-strong-hover']!)).toBeGreaterThanOrEqual(4.5)
      for (const bg of ['background', 'surface']) {
        expect(contrastRatio(t['primary-strong']!, t[bg]!), `strong fill on ${bg}`).toBeGreaterThanOrEqual(3)
      }
    })
  }
})
