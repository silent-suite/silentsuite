import { afterEach, describe, expect, it, vi } from 'vitest'

// A self-host build without an explicit Etebase URL must talk to the server on the
// same origin the browser loaded the app from, so one artifact works under any
// device name. Explicit configuration and hosted defaults must stay unchanged.

const logIn = vi.fn()
const saveSession = vi.fn()

vi.mock('@silentsuite/core', () => ({ logIn, saveSession }))

const UMBREL_ONE = 'https://umbrel.local'
const UMBREL_TWO = 'https://silentsuite-box.example.test:8443'

async function loadAt(pageUrl: string, env: { selfHosted?: string; serverUrl?: string }) {
  const dom = (globalThis as { jsdom?: { reconfigure(options: { url: string }): void } }).jsdom
  if (!dom) throw new Error('fixture: vitest jsdom handle unavailable')
  dom.reconfigure({ url: pageUrl })
  if (window.location.href !== new URL(pageUrl).href) throw new Error('fixture: page URL not applied')

  vi.resetModules()
  vi.unstubAllEnvs()
  if (env.selfHosted !== undefined) vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', env.selfHosted)
  else delete process.env.NEXT_PUBLIC_SELF_HOSTED
  if (env.serverUrl !== undefined) vi.stubEnv('NEXT_PUBLIC_ETEBASE_SERVER_URL', env.serverUrl)
  else delete process.env.NEXT_PUBLIC_ETEBASE_SERVER_URL

  const config = await import('@/app/lib/config')
  const selfHosted = await import('@/app/lib/self-hosted')
  const auth = await import('@/app/lib/etebase-auth')
  return { config, selfHosted, auth }
}

afterEach(() => {
  vi.unstubAllEnvs()
  logIn.mockReset()
  saveSession.mockReset()
})

describe('self-host build without an explicit Etebase URL', () => {
  it.each([
    [UMBREL_ONE, `${UMBREL_ONE}/calendar?view=week&token=not-an-endpoint#today`],
    [UMBREL_TWO, `${UMBREL_TWO}/login/?next=%2Fsettings#frag`],
  ])('uses the browser origin %s, excluding path, query and fragment', async (origin, pageUrl) => {
    const { config } = await loadAt(pageUrl, { selfHosted: 'true' })

    expect(config.ETEBASE_SERVER_URL).toBe(origin)
  })

  it('treats an empty build-time URL as unset', async () => {
    const { config } = await loadAt(`${UMBREL_ONE}/`, { selfHosted: 'true', serverUrl: '' })

    expect(config.ETEBASE_SERVER_URL).toBe(UMBREL_ONE)
  })

  it('sends the default login through the core client to the browser origin', async () => {
    logIn.mockResolvedValue({ authToken: 'synthetic-auth-token' })
    saveSession.mockResolvedValue('synthetic-saved-session')
    const { auth } = await loadAt(`${UMBREL_TWO}/login`, { selfHosted: 'true' })

    await auth.etebaseLogIn('synthetic@example.invalid', 'synthetic-password')

    expect(logIn).toHaveBeenCalledWith(UMBREL_TWO, 'synthetic@example.invalid', 'synthetic-password')
  })

  it('classifies the same-origin server as default and other servers as custom', async () => {
    const { selfHosted } = await loadAt(`${UMBREL_ONE}/settings`, { selfHosted: 'true' })

    expect(selfHosted.isSelfHosted).toBe(true)
    expect(selfHosted.isCustomServer(UMBREL_ONE)).toBe(false)
    expect(selfHosted.isCustomServer(`${UMBREL_ONE}/`)).toBe(false)
    expect(selfHosted.isCustomServer(undefined)).toBe(false)
    expect(selfHosted.isCustomServer('https://other-server.example.test')).toBe(true)
    expect(selfHosted.isUserSelfHosted('https://other-server.example.test')).toBe(true)
  })
})

describe('explicit configuration and hosted defaults are unchanged', () => {
  it.each([
    ['self-host', 'true'],
    ['hosted', undefined],
  ])('an explicit URL wins in %s mode', async (_mode, selfHostedFlag) => {
    const explicit = 'https://configured-server.example.test'
    const { config, selfHosted } = await loadAt(`${UMBREL_ONE}/`, {
      selfHosted: selfHostedFlag,
      serverUrl: explicit,
    })

    expect(config.ETEBASE_SERVER_URL).toBe(explicit)
    expect(selfHosted.isCustomServer(explicit)).toBe(false)
    expect(selfHosted.isCustomServer(UMBREL_ONE)).toBe(true)
  })

  it('a hosted build with an empty URL keeps the existing empty value, not the page origin', async () => {
    const { config } = await loadAt(`${UMBREL_ONE}/`, { serverUrl: '' })

    expect(config.ETEBASE_SERVER_URL).toBe('')
  })

  it('a hosted build without configuration keeps the existing fallback, not the page origin', async () => {
    const { config, selfHosted } = await loadAt(`${UMBREL_ONE}/`, {})

    expect(config.ETEBASE_SERVER_URL).toBe('http://localhost:3735')
    expect(selfHosted.isSelfHosted).toBe(false)
    expect(selfHosted.isCustomServer(UMBREL_ONE)).toBe(true)
  })
})
