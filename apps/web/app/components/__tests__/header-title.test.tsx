import { render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/messages/en.json'
import it_ from '@/messages/it.json'
import { Header } from '../header'

const nav = vi.hoisted(() => ({ pathname: '/tasks' }))

vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }))
vi.mock('@/app/components/theme-toggle', () => ({ ThemeToggle: () => null }))
vi.mock('@/app/components/SyncIndicator', () => ({ SyncIndicator: () => null }))
vi.mock('@/app/components/SignOutDialog', () => ({ SignOutDialog: () => null }))
vi.mock('@/app/stores/use-auth-store', () => ({ useAuthStore: () => ({ user: null, logout: vi.fn() }) }))
vi.mock('@/app/lib/local-only-changes', () => ({
  captureSignOutAccount: vi.fn(),
  isSignOutAccountCurrent: vi.fn(),
  readLocalOnlyChanges: vi.fn(),
}))

function renderHeader(locale: 'en' | 'it') {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'it' ? it_ : en}>
      <Header />
    </NextIntlClientProvider>,
  )
}

describe('Header route title', () => {
  beforeEach(() => {
    document.title = ''
  })

  it.each([
    ['/calendar', 'Calendario'],
    ['/tasks', 'Attività'],
    ['/notes', 'Note'],
    ['/contacts', 'Contatti'],
    ['/settings/account', 'Impostazioni'],
  ])('uses the sidebar navigation name for %s in Italian', (pathname, name) => {
    nav.pathname = pathname
    renderHeader('it')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(name)
    expect(document.title).toBe(`${name} | SilentSuite`)
  })

  it('keeps the English names and the plain fallback', () => {
    nav.pathname = '/tasks'
    const view = renderHeader('en')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Tasks')
    expect(document.title).toBe('Tasks | SilentSuite')
    view.unmount()

    nav.pathname = '/admin'
    renderHeader('en')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('SilentSuite')
    expect(document.title).toBe('SilentSuite')
  })
})
