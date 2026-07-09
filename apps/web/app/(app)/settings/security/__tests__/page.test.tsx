import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import SecurityPage from '../page'

const mocks = vi.hoisted(() => {
  const logout = vi.fn()
  const authStore = Object.assign(
    (selector?: (state: any) => unknown) => (selector ? selector({ logout }) : { logout }),
    { getState: () => ({ user: { email: 'fixture@example.test' }, logout }) },
  )
  const etebaseState = {
    accountFingerprint: 'fp-test-123',
    account: null,
  }
  const etebaseStore = Object.assign(
    (selector: (state: typeof etebaseState) => unknown) => selector(etebaseState),
    { getState: () => etebaseState },
  )
  return { logout, authStore, etebaseStore }
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: mocks.authStore,
}))

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: mocks.etebaseStore,
}))

vi.mock('@/app/lib/self-hosted', () => ({
  isSelfHosted: false,
}))

vi.mock('@/app/lib/config', () => ({
  BILLING_API_URL: 'https://api.silentsuite.io',
  ETEBASE_SERVER_URL: 'https://server.silentsuite.io',
}))

describe('SecurityPage diagnostics', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.unstubAllGlobals()
  })

  it('copies restore diagnostics from Settings instead of app chrome', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    Object.defineProperty(window, 'location', {
      value: { hostname: 'previewapp.silentsuite.io', search: '' },
      configurable: true,
    })
    sessionStorage.setItem('silentsuite.restore-diagnostics.v1', JSON.stringify({
      version: 1,
      source: 'restore',
      generatedAtMs: 1,
      etebaseHost: 'server.silentsuite.io',
      billingHost: 'api.silentsuite.io',
      failedPhase: null,
      entries: [{ phase: 'syncEngineStart', status: 'ok' }],
    }))

    renderWithIntl(<SecurityPage />)

    expect(screen.getByRole('heading', { name: 'Restore diagnostics' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText.mock.calls[0]![0]).toContain('"failedPhase":null')
    expect(await screen.findByRole('button', { name: 'Diagnostics copied' })).toBeInTheDocument()
  })
})
