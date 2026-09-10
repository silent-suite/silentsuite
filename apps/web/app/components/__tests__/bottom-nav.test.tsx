import { screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BottomNav } from '../bottom-nav'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { useExperimentalStore } from '@/app/stores/use-experimental-store'

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: (selector: (state: { accountFingerprint: string }) => unknown) => selector({ accountFingerprint: 'nav-account' }),
}))

const nav = vi.hoisted(() => ({ pathname: '/calendar' }))

vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }))

// Real en.json messages are used on purpose so a missing `Navigation.notes`
// key (or any other tab label) fails here instead of rendering a raw key.
function renderNav(pathname: string) {
  nav.pathname = pathname
  renderWithIntl(<BottomNav />)
  return screen.getByRole('navigation', { name: 'Mobile navigation' })
}

describe('BottomNav', () => {
  beforeEach(() => {
    useExperimentalStore.setState({ hydrated: true, notesAccounts: ['nav-account'] })
    nav.pathname = '/calendar'
  })

  it('exposes Notes as a top-level tab, in the same order as the desktop sidebar', () => {
    const mobileNav = renderNav('/calendar')
    const links = within(mobileNav).getAllByRole('link')

    expect(links.map((link) => link.textContent)).toEqual(['Calendar', 'Tasks', 'Notes', 'Contacts', 'Settings'])
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/calendar', '/tasks', '/notes', '/contacts', '/settings'])

    const notes = within(mobileNav).getByRole('link', { name: 'Notes' })
    expect(notes).toHaveAttribute('href', '/notes')
    // Exactly one Notes tab: guards against a duplicate entry being added later.
    expect(within(mobileNav).getAllByRole('link', { name: 'Notes' })).toHaveLength(1)
  })

  it('hides Notes while disabled without removing other navigation', () => {
    useExperimentalStore.setState({ notesAccounts: [] })
    const mobileNav = renderNav('/calendar')
    expect(within(mobileNav).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/calendar', '/tasks', '/contacts', '/settings'])
  })

  it('marks Notes as the current page on /notes and nested notes routes only', () => {
    const mobileNav = renderNav('/notes')
    const notes = within(mobileNav).getByRole('link', { name: 'Notes' })
    expect(notes).toHaveAttribute('aria-current', 'page')

    const current = within(mobileNav).getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page')
    expect(current).toEqual([notes])
  })

  it('keeps Notes active on nested notes routes and inactive elsewhere', () => {
    const nested = renderNav('/notes/some-note-id')
    expect(within(nested).getByRole('link', { name: 'Notes' })).toHaveAttribute('aria-current', 'page')
    expect(within(nested).getByRole('link', { name: 'Calendar' })).not.toHaveAttribute('aria-current')
  })

  it('is not active on other pages', () => {
    const mobileNav = renderNav('/tasks')
    expect(within(mobileNav).getByRole('link', { name: 'Notes' })).not.toHaveAttribute('aria-current')
    expect(within(mobileNav).getByRole('link', { name: 'Tasks' })).toHaveAttribute('aria-current', 'page')
  })

  it('keeps the mobile-only, fixed-bottom layout contract that the app layout relies on', () => {
    // jsdom does not evaluate media queries, so assert the Tailwind classes the
    // (app)/layout.tsx `pb-20 md:pb-4` main padding is paired with.
    const mobileNav = renderNav('/notes')
    expect(mobileNav).toHaveClass('fixed', 'bottom-0', 'md:hidden', 'bottom-nav-safe')
  })
})
