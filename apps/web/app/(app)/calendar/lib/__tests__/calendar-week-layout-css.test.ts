import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const globalsCss = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8')

describe('Schedule-X week layout CSS', () => {
  it('themes Schedule-X background surfaces so exposed scroll space is not white in dark mode', () => {
    expect(globalsCss).toContain('--sx-color-background: rgb(var(--background));')
    expect(globalsCss).toContain('--sx-color-on-background: rgb(var(--foreground));')
    expect(globalsCss).toMatch(/\.sx-silentsuite-calendar \.sx__calendar[\s\S]*background: rgb\(var\(--background\)\)/)
    expect(globalsCss).toMatch(/\.sx-silentsuite-calendar \.sx__view-container[\s\S]*background: rgb\(var\(--background\)\)/)
  })

  it('does not override Schedule-X week grid height calculations', () => {
    expect(globalsCss).not.toContain('height: max(var(--sx-week-grid-height), 100%)')
    expect(globalsCss).not.toMatch(/\.sx-silentsuite-calendar \.sx__week-wrapper[\s\S]*min-height: 100%/)
  })
})

describe('Schedule-X mobile multi-day CSS', () => {
  it('fits the 7-day view to the screen instead of a wider sideways-scrolling grid', () => {
    const rule = globalsCss.match(/\.sx-silentsuite-calendar\[data-mobile-days="7"\]\s*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    expect(rule![1]).toMatch(/min-width:\s*0;/)
  })
})

describe('Schedule-X month layout CSS', () => {
  it('allows connected multi-day bars to keep the width calculated by Schedule-X', () => {
    expect(globalsCss).toMatch(
      /\.sx-silentsuite-calendar \.sx__month-grid-event\.ss-month-multiday\s*\{[^}]*max-width:\s*none/,
    )
  })

  it('keeps the chip start time whole and lets only the title truncate', () => {
    const time = globalsCss.match(
      /\.sx-silentsuite-calendar \.sx__month-grid-event \.sx__month-grid-event-time\s*\{([^}]*)\}/,
    )
    expect(time).not.toBeNull()
    expect(time![1]).toMatch(/flex:\s*none;/)
    expect(time![1]).toMatch(/min-width:\s*auto;/)
    expect(time![1]).toMatch(/overflow:\s*visible;/)
    expect(time![1]).toMatch(/text-overflow:\s*clip;/)

    const title = globalsCss.match(
      /\.sx-silentsuite-calendar \.sx__month-grid-event \.sx__month-grid-event-title\s*\{([^}]*)\}/,
    )
    expect(title).not.toBeNull()
    expect(title![1]).toMatch(/flex:\s*1 1 auto;/)
  })
})
