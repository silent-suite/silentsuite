import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../sidebar'

const state = vi.hoisted(() => ({ preferenceStatus: 'loading', miniCalendar: vi.fn() }))

vi.mock('next/navigation', () => ({ usePathname: () => '/calendar' }))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/app/stores/use-sidebar-store', () => ({
  useSidebarStore: () => ({ isExpanded: true, toggle: vi.fn() }),
  initializeSidebar: vi.fn(),
}))
vi.mock('@/app/stores/use-auth-store', () => ({ useAuthStore: () => false }))
vi.mock('@/app/lib/self-hosted', () => ({ isSelfHosted: false }))
vi.mock('@/app/stores/use-preferences-sync-store', () => ({
  usePreferencesSyncStore: (selector: (value: { status: string }) => unknown) => selector({ status: state.preferenceStatus }),
}))
vi.mock('@/app/(app)/calendar/components/MiniCalendar', () => ({
  MiniCalendar: () => { state.miniCalendar(); return <div>mini calendar</div> },
}))
vi.mock('@/app/components/CalendarListPanel', () => ({ CalendarListPanel: () => <div>calendar lists</div> }))
vi.mock('@/app/components/TaskListPanel', () => ({ TaskListPanel: () => null }))
vi.mock('@/app/components/ContactListPanel', () => ({ ContactListPanel: () => null }))
vi.mock('@/app/components/NotebookListPanel', () => ({ NotebookListPanel: () => null }))
vi.mock('@/app/components/OnboardingChecklist', () => ({ OnboardingChecklist: () => null }))

describe('Sidebar preference readiness', () => {
  beforeEach(() => { state.preferenceStatus = 'loading'; state.miniCalendar.mockClear() })

  it('keeps navigation and calendar lists visible without mounting MiniCalendar while pending', () => {
    render(<Sidebar />)

    expect(state.miniCalendar).not.toHaveBeenCalled()
    expect(screen.getByText('calendar lists')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /calendar/i })).toBeInTheDocument()
  })

  it.each(['ready', 'unavailable', 'failed'])('mounts MiniCalendar at terminal status %s', (status) => {
    state.preferenceStatus = status
    render(<Sidebar />)
    expect(screen.getByText('mini calendar')).toBeInTheDocument()
  })
})
