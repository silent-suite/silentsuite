import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function load(androidBundle: boolean) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_ANDROID_BUNDLE', androidBundle ? 'true' : 'false')
  return import('../android-bundle')
}

describe('android bundle account binding', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.location.hash = ''
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    window.location.hash = ''
  })

  it('does nothing outside the Android bundle', async () => {
    const bundle = await load(false)
    window.location.hash = '#android-account=ada%40example.org'
    expect(bundle.isAndroidBundle).toBe(false)
    expect(bundle.androidBoundAccount()).toBeNull()
    expect(window.localStorage.length).toBe(0)
    expect(bundle.isLoginAllowedForAndroidAccount('anyone@example.org', null)).toBe(true)
  })

  it('takes the account from the start URL and remembers it', async () => {
    const bundle = await load(true)
    window.location.hash = '#android-account=Ada%40Example.org'
    expect(bundle.androidBoundAccount()).toBe('ada@example.org')
    window.location.hash = ''
    expect(bundle.androidBoundAccount()).toBe('ada@example.org')
  })

  it('lets only the bound account sign in', async () => {
    const bundle = await load(true)
    expect(bundle.isLoginAllowedForAndroidAccount(' Ada@Example.org ', 'ada@example.org')).toBe(true)
    expect(bundle.isLoginAllowedForAndroidAccount('bob@example.org', 'ada@example.org')).toBe(false)
    // Opened without an account: nobody may sign in.
    expect(bundle.isLoginAllowedForAndroidAccount('ada@example.org', null)).toBe(false)
  })

  it('ignores other fragments and an empty account', async () => {
    const bundle = await load(true)
    window.location.hash = '#main-content'
    expect(bundle.androidBoundAccount()).toBeNull()
    window.location.hash = '#android-account='
    expect(bundle.androidBoundAccount()).toBeNull()
  })
})
