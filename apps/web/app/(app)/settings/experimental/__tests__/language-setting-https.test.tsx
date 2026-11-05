// @vitest-environment-options {"url":"https://app.silentsuite.test/settings/experimental"}
import { fireEvent, render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ExperimentalSettingsPage from '../page'
import { getMessagesForLocale } from '@/i18n/messages'

const nav = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/experimental',
  useRouter: () => ({ refresh: nav.refresh, push: vi.fn(), replace: vi.fn() }),
}))
vi.mock('@/app/stores/use-auth-store', () => ({ useAuthStore: { getState: () => ({ canWrite: () => true }) } }))

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).cookie
})

describe('Experimental web language setting over HTTPS', () => {
  it('marks the preference cookie Secure on HTTPS origins', () => {
    expect(window.location.protocol).toBe('https:')
    const writes: string[] = []
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => '', set: (v: string) => { writes.push(v) } })
    render(
      <NextIntlClientProvider locale="en" messages={getMessagesForLocale('en')}>
        <ExperimentalSettingsPage />
      </NextIntlClientProvider>,
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Italiano (partial, experimental)' }))
    expect(writes).toEqual(['silentsuite-locale=it; Path=/; Max-Age=31536000; SameSite=Lax; Secure'])
    expect(nav.refresh).toHaveBeenCalledTimes(1)
  })
})
