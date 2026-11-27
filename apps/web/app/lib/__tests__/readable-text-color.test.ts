import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio, DARK_TEXT, LIGHT_TEXT, readableTextColor } from '../readable-text-color'

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

  it('keeps white text on a translucent chip over the dark surface (review fix: WEB-07)', () => {
    const dark = tokens('.dark')
    expect(readableTextColor('#ffffff00')).toBe(LIGHT_TEXT)
    expect(readableTextColor('#fff0')).toBe(LIGHT_TEXT)
    expect(readableTextColor('#ffffff80')).toBe(LIGHT_TEXT)
    // A transparent chip shows the surface behind it, where white text stays readable.
    for (const bg of ['background', 'surface']) {
      expect(contrastRatio(readableTextColor('#ffffff00'), dark[bg]!), `text on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
    // A nearly opaque colour still decides by itself.
    expect(readableTextColor('#ffffffee')).toBe(DARK_TEXT)
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
