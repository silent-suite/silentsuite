import { act, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsLayout from '../layout'
import SettingsPage from '../page'

const state = vi.hoisted(() => ({
  pathname: '/settings',
  selfHosted: false,
  redirect: vi.fn(),
  replace: vi.fn(),
  wide: false,
  listeners: new Set<() => void>(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  redirect: state.redirect,
  useRouter: () => ({ replace: state.replace }),
}))

function setViewportWide(wide: boolean) {
  state.wide = wide
  state.listeners.forEach((listener) => listener())
}
vi.mock('@/app/lib/self-hosted', () => ({
  get isSelfHosted() {
    return state.selfHosted
  },
}))

const hostedLinks = [
  ['Account', '/settings/account', 'Profile, date & time, reminders'],
  ['Security', '/settings/security', 'Password & account fingerprint'],
  ['Subscription', '/settings/subscription', 'Plan & billing'],
  ['Sharing', '/settings/sharing', 'Invitations & members'],
  ['Import', '/settings/import', 'Calendars, tasks & contacts'],
  ['Export', '/settings/export', 'Download your data'],
  ['Mobile app', '/settings/mobile', 'Android install options'],
  ['Desktop bridge', '/settings/desktop', 'Use desktop calendar clients'],
  ['Experimental', '/settings/experimental', 'Optional features in development'],
]

function settingsNav() {
  return screen.getByRole('navigation', { name: 'Settings' })
}

function navLinks() {
  return within(settingsNav()).getAllByRole('link')
}

function renderDetail(pathname: string) {
  state.pathname = pathname
  return render(
    <SettingsLayout>
      <p>detail content</p>
    </SettingsLayout>,
  )
}

describe('settings navigation', () => {
  beforeEach(() => {
    state.pathname = '/settings'
    state.selfHosted = false
    state.redirect.mockClear()
    state.replace.mockClear()
    state.wide = false
    state.listeners.clear()
    window.matchMedia = vi.fn((query: string) => ({
      get matches() {
        return query === '(min-width: 1024px)' && state.wide
      },
      media: query,
      addEventListener: (_: string, listener: () => void) => state.listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => state.listeners.delete(listener),
    })) as unknown as typeof window.matchMedia
  })

  it('opens Account straight away when the settings rail is visible', () => {
    state.wide = true
    render(
      <SettingsLayout>
        <SettingsPage />
      </SettingsLayout>,
    )

    expect(state.replace).toHaveBeenCalledWith('/settings/account')
    expect(settingsNav().parentElement).toHaveClass('lg:hidden')
  })

  it('keeps the overview list below lg and opens Account if the window widens', () => {
    const view = render(
      <SettingsLayout>
        <SettingsPage />
      </SettingsLayout>,
    )
    expect(state.replace).not.toHaveBeenCalled()

    act(() => setViewportWide(true))
    expect(state.replace).toHaveBeenCalledWith('/settings/account')

    view.unmount()
    expect(state.listeners.size).toBe(0)
  })

  it('renders /settings as a grouped overview on narrow screens', () => {
    render(
      <SettingsLayout>
        <SettingsPage />
      </SettingsLayout>,
    )

    expect(state.redirect).not.toHaveBeenCalled()
    expect(within(settingsNav()).getAllByRole('heading').map((h) => h.textContent)).toEqual([
      'Account',
      'Data',
      'Get the apps',
      'Advanced',
    ])
    const links = navLinks()
    expect(links.map((link) => link.getAttribute('href'))).toEqual(hostedLinks.map(([, href]) => href))
    links.forEach((link, i) => {
      const [label, , hint] = hostedLinks[i]
      expect(link).toHaveAccessibleName(new RegExp(`^${label}`))
      expect(link).toHaveTextContent(hint)
      expect(link).toHaveClass('min-h-11', 'focus-visible:ring-2')
      expect(link).not.toHaveAttribute('aria-current')
      expect(link).not.toHaveAttribute('role', 'tab')
    })
  })

  it('does not duplicate a rail or back link on the overview', () => {
    render(
      <SettingsLayout>
        <SettingsPage />
      </SettingsLayout>,
    )

    expect(screen.getAllByRole('navigation', { name: 'Settings' })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).not.toHaveClass('sr-only')
    expect(document.querySelector('a[href="/settings"]')).toBeNull()
  })

  it('omits Subscription from the overview and the rail when self-hosted', () => {
    state.selfHosted = true
    const view = render(<SettingsPage />)
    expect(navLinks().map((link) => link.getAttribute('href'))).not.toContain('/settings/subscription')
    expect(navLinks()).toHaveLength(hostedLinks.length - 1)
    view.unmount()

    renderDetail('/settings/account')
    expect(navLinks().map((link) => link.getAttribute('href'))).not.toContain('/settings/subscription')
    expect(navLinks()).toHaveLength(hostedLinks.length - 1)
  })

  it('shows a desktop-only grouped rail with the current page marked on detail routes', () => {
    renderDetail('/settings/security')

    const nav = settingsNav()
    expect(nav.closest('.hidden.lg\\:block')).not.toBeNull()
    expect(navLinks().map((link) => link.getAttribute('href'))).toEqual(hostedLinks.map(([, href]) => href))
    expect(within(nav).getByRole('link', { name: 'Security' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getAllByRole('link').filter((link) => link.hasAttribute('aria-current'))).toHaveLength(1)
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it('marks nested paths active only on whole path segments', () => {
    const view = renderDetail('/settings/sharing/invite')
    expect(within(settingsNav()).getByRole('link', { name: 'Sharing' })).toHaveAttribute('aria-current', 'page')
    view.unmount()

    renderDetail('/settings/exporter')
    expect(within(settingsNav()).getByRole('link', { name: 'Export' })).not.toHaveAttribute('aria-current')
  })

  it('links back to the overview below lg and keeps detail content shrinkable', () => {
    renderDetail('/settings/export')

    const back = screen.getByRole('link', { name: 'Settings' })
    expect(back).toHaveAttribute('href', '/settings')
    expect(back).toHaveClass('lg:hidden', 'min-h-11')
    expect(screen.getByText('detail content').parentElement).toHaveClass('min-w-0')
    expect(document.querySelector('.max-w-4xl')).not.toBeNull()
    expect(document.querySelector('.overflow-x-auto, .scrollbar-hide')).toBeNull()
  })
})
