import { fireEvent, render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ExperimentalSettingsPage from '../page'
import { getMessagesForLocale } from '@/i18n/messages'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useExperimentalStore } from '@/app/stores/use-experimental-store'

const nav = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/experimental',
  useRouter: () => ({ refresh: nav.refresh, push: vi.fn(), replace: vi.fn() }),
}))
vi.mock('@/app/stores/use-auth-store', () => ({ useAuthStore: { getState: () => ({ canWrite: () => true }) } }))
vi.mock('@/app/stores/use-etebase-store', async () => {
  const { create } = await import('zustand')
  return { useEtebaseStore: create(() => ({
    account: {}, accountFingerprint: 'account-a', isInitialized: true, restoreBlocked: false,
    domainLoadState: { notes: 'loaded' }, collections: { notes: [] }, createCollection: vi.fn(),
  })) }
})

let cookieWrites: string[] = []

function renderAs(locale: 'en' | 'it') {
  return render(
    <NextIntlClientProvider locale={locale} messages={getMessagesForLocale(locale)}>
      <ExperimentalSettingsPage />
    </NextIntlClientProvider>,
  )
}

beforeEach(() => {
  nav.refresh.mockReset()
  localStorage.clear()
  useExperimentalStore.setState({ hydrated: true, notesAccounts: [] })
  useEtebaseStore.setState({ accountFingerprint: 'account-a' })
  cookieWrites = []
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => '',
    set: (value: string) => { cookieWrites.push(value) },
  })
})

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).cookie
})

describe('Experimental web language setting', () => {
  it('defaults to English and explains the partial, per-browser scope', () => {
    renderAs('en')
    const group = screen.getByRole('radiogroup', { name: 'Language' })
    expect(group).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'English' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Italiano (partial, experimental)' })).not.toBeChecked()
    expect(group).toHaveAccessibleDescription(/most of the app is still in english/i)
    expect(group).toHaveAccessibleDescription(/this browser/i)
    expect(cookieWrites).toEqual([])
    expect(nav.refresh).not.toHaveBeenCalled()
  })

  it('selecting Italiano persists a strict first-party cookie and refreshes the rendered UI', () => {
    renderAs('en')
    fireEvent.click(screen.getByRole('radio', { name: 'Italiano (partial, experimental)' }))
    expect(cookieWrites).toEqual(['silentsuite-locale=it; Path=/; Max-Age=31536000; SameSite=Lax'])
    expect(nav.refresh).toHaveBeenCalledTimes(1)
  })

  it('reflects a persisted Italian choice after reload and switching back to English works', () => {
    renderAs('it')
    expect(screen.getByRole('radiogroup', { name: 'Lingua' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Italiano (parziale, sperimentale)' })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: 'English' }))
    expect(cookieWrites).toEqual(['silentsuite-locale=en; Path=/; Max-Age=31536000; SameSite=Lax'])
    expect(nav.refresh).toHaveBeenCalledTimes(1)
  })

  it('does not rewrite or refresh when the current language is chosen again, and leaves Notes untouched', () => {
    renderAs('en')
    fireEvent.click(screen.getByRole('radio', { name: 'English' }))
    expect(cookieWrites).toEqual([])
    expect(nav.refresh).not.toHaveBeenCalled()
    expect(screen.getByRole('switch', { name: 'Enable Notes' })).not.toBeChecked()
    expect(useExperimentalStore.getState().notesAccounts).toEqual([])
  })
})
