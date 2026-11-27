import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const globalsCss = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8')

/** The custom properties declared directly in the first block for `selector`. */
function tokens(selector: string): Record<string, number[]> {
  const block = globalsCss.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
  const found: Record<string, number[]> = {}
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*(\d+ \d+ \d+);/g)) found[name] = value.split(' ').map(Number)
  return found
}

function luminance(rgb: number[]): number {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: number[], b: number[]): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

describe('focus outline contrast (WCAG 1.4.11)', () => {
  it('draws every focus-visible outline in the focus-ring colour', () => {
    expect(globalsCss).toMatch(/\*:focus-visible\s*\{[^}]*outline: 2px solid rgb\(var\(--focus-ring\)\)/)
  })

  it('uses no brand primary outline in any focus-visible rule', () => {
    const rules = [...globalsCss.matchAll(/([^{}]*:focus-visible[^{}]*)\{([^}]*)\}/g)]
    expect(rules.length).toBeGreaterThan(1)
    for (const [, selector, body] of rules) {
      expect(`${selector.trim()} { ${body.match(/outline[^;]*;/g)?.join(' ') ?? ''} }`).not.toMatch(/outline[^;]*--primary/)
    }
  })

  it.each([':root', '.dark'])('keeps the focus-ring colour at 3:1 or more on the background and surface in %s', (selector) => {
    const theme = tokens(selector)
    expect(theme['focus-ring']).toBeDefined()
    expect(contrast(theme['focus-ring'], theme.background)).toBeGreaterThanOrEqual(3)
    expect(contrast(theme['focus-ring'], theme.surface)).toBeGreaterThanOrEqual(3)
  })

  it('leaves the brand primary colour unchanged', () => {
    expect(tokens(':root').primary).toEqual([16, 185, 129])
    expect(tokens('.dark').primary).toEqual([52, 211, 153])
  })
})
