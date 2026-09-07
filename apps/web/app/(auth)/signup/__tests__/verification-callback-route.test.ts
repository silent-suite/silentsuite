// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('issued signup email callback route', () => {
  it('registers the historical email URL against the annual signup consumer', () => {
    const page = resolve(process.cwd(), 'app/(auth)/signup/verify-email/page.tsx')
    expect(existsSync(page), 'already-issued email callback must be a registered Next route').toBe(true)
    expect(readFileSync(page, 'utf8')).toContain("export { default } from '../page'")
  })
})
