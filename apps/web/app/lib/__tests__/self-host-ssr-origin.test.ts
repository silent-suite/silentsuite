// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

// Server-side rendering has no browser origin. A self-host build without an
// explicit URL must import safely there and must not fall back to a fixed
// localhost endpoint that the browser would then use.

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('self-host endpoint during SSR', () => {
  it('imports without window and does not pick a fixed localhost endpoint', async () => {
    expect(typeof window).toBe('undefined')
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    delete process.env.NEXT_PUBLIC_ETEBASE_SERVER_URL

    const config = await import('@/app/lib/config')
    const selfHosted = await import('@/app/lib/self-hosted')

    expect(config.ETEBASE_SERVER_URL).not.toBe('http://localhost:3735')
    expect(config.ETEBASE_SERVER_URL).not.toMatch(/localhost|server\.silentsuite\.io/)
    expect(selfHosted.isCustomServer(undefined)).toBe(false)
  })

  it('keeps an explicit URL during SSR', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    vi.stubEnv('NEXT_PUBLIC_ETEBASE_SERVER_URL', 'https://configured-server.example.test')

    const config = await import('@/app/lib/config')

    expect(config.ETEBASE_SERVER_URL).toBe('https://configured-server.example.test')
  })
})
