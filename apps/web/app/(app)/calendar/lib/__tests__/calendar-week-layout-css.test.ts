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

  it('lets the fixed Schedule-X week grid cover taller calendar panes', () => {
    expect(globalsCss).toMatch(/\.sx-silentsuite-calendar \.sx__week-wrapper[\s\S]*min-height: 100%/)
    expect(globalsCss).toMatch(/\.sx-silentsuite-calendar \.sx__week-grid[\s\S]*height: max\(var\(--sx-week-grid-height\), 100%\)/)
  })
})
