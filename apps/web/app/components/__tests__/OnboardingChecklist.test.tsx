import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  events: [] as unknown[],
  contacts: [] as unknown[],
  tasks: [] as unknown[],
  readOnly: false,
  wide: false,
  listeners: new Set<() => void>(),
}))

vi.mock('@/app/stores/use-calendar-store', () => ({
  useCalendarStore: (selector: (value: { events: unknown[] }) => unknown) => selector({ events: state.events }),
}))
vi.mock('@/app/stores/use-contact-store', () => ({
  useContactStore: (selector: (value: { contacts: unknown[] }) => unknown) => selector({ contacts: state.contacts }),
}))
vi.mock('@/app/stores/use-task-store', () => ({
  useTaskStore: (selector: (value: { tasks: unknown[] }) => unknown) => selector({ tasks: state.tasks }),
}))
vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: (selector: (value: { isReadOnly: () => boolean }) => unknown) => selector({ isReadOnly: () => state.readOnly }),
}))

import { OnboardingChecklist, OnboardingChecklistAt } from '../OnboardingChecklist'

describe('OnboardingChecklist', () => {
  beforeEach(() => {
    localStorage.clear()
    state.events = []
    state.contacts = []
    state.tasks = []
    state.readOnly = false
  })

  it('keeps optional mobile setup out of onboarding completion', () => {
    render(<OnboardingChecklist />)

    expect(screen.getByText('0/3')).toBeInTheDocument()
    expect(screen.queryByText('Get the mobile app')).not.toBeInTheDocument()
  })

  it('keeps checklist controls as separate interactive elements', () => {
    render(<OnboardingChecklist />)

    for (const button of screen.getAllByRole('button')) {
      expect(button.querySelector('button')).toBeNull()
    }
  })

  it('ignores legacy mobile completion values', () => {
    localStorage.setItem(
      'silentsuite-onboarding-checklist',
      JSON.stringify({ dismissed: false, completed: ['download-app'] }),
    )

    render(<OnboardingChecklist />)

    expect(screen.getByText('0/3')).toBeInTheDocument()
    expect(screen.queryByText('Get the mobile app')).not.toBeInTheDocument()
  })

  it('preserves automatic completion for imported data', async () => {
    state.events = [{}]
    state.contacts = [{}]
    state.tasks = [{}]

    render(<OnboardingChecklist />)

    await waitFor(() => {
      expect(screen.queryByText('Get started')).not.toBeInTheDocument()
    })
  })

  it('combines imported data with legacy mobile completion during hydration', async () => {
    localStorage.setItem(
      'silentsuite-onboarding-checklist',
      JSON.stringify({ dismissed: false, completed: ['download-app'] }),
    )
    state.events = [{}]
    state.contacts = [{}]
    state.tasks = [{}]

    render(<OnboardingChecklist />)

    await waitFor(() => {
      expect(screen.queryByText('Get started')).not.toBeInTheDocument()
    })
  })

  it('ignores malformed persisted completion without losing imported data', async () => {
    localStorage.setItem(
      'silentsuite-onboarding-checklist',
      JSON.stringify({ dismissed: false, completed: {} }),
    )
    state.events = [{}]
    state.contacts = [{}]
    state.tasks = [{}]

    render(<OnboardingChecklist />)

    await waitFor(() => {
      expect(screen.queryByText('Get started')).not.toBeInTheDocument()
    })
  })

  it('stays hidden while the account is read-only, without dismissing it', () => {
    state.readOnly = true
    const rendered = render(<OnboardingChecklist />)

    expect(screen.queryByText('Get started')).not.toBeInTheDocument()
    expect(screen.queryByText('Import your calendar')).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('silentsuite-onboarding-checklist') ?? '{}').dismissed).toBe(false)

    state.readOnly = false
    rendered.rerender(<OnboardingChecklist />)
    expect(screen.getByText('Get started')).toBeInTheDocument()
  })
})

describe('OnboardingChecklistAt', () => {
  const stored = () => JSON.parse(localStorage.getItem('silentsuite-onboarding-checklist') ?? '{}')
  function setWide(wide: boolean) {
    state.wide = wide
    state.listeners.forEach((listener) => listener())
  }
  // Both copies, as the app has them: the sidebar's (md and up) and the phone settings one.
  function renderBoth() {
    return render(
      <>
        <div data-testid="sidebar"><OnboardingChecklistAt width="md-up" /></div>
        <div data-testid="phone"><OnboardingChecklistAt width="below-md" /></div>
      </>,
    )
  }

  beforeEach(() => {
    localStorage.clear()
    state.events = []
    state.contacts = []
    state.tasks = []
    state.readOnly = false
    state.wide = false
    state.listeners.clear()
    window.matchMedia = vi.fn((query: string) => ({
      get matches() {
        return query === '(min-width: 768px)' && state.wide
      },
      media: query,
      addEventListener: (_: string, listener: () => void) => state.listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => state.listeners.delete(listener),
    })) as unknown as typeof window.matchMedia
  })

  it('mounts only the copy for the current width, never both', () => {
    const view = renderBoth()
    expect(screen.getAllByText('Get started')).toHaveLength(1)
    expect(screen.getByTestId('phone')).toHaveTextContent('Get started')
    expect(screen.getByTestId('sidebar')).toBeEmptyDOMElement()

    act(() => setWide(true))
    expect(screen.getAllByText('Get started')).toHaveLength(1)
    expect(screen.getByTestId('sidebar')).toHaveTextContent('Get started')
    expect(screen.getByTestId('phone')).toBeEmptyDOMElement()

    view.unmount()
    expect(state.listeners.size).toBe(0)
  })

  it('keeps a phone dismissal when the other copy mounts and data arrives', () => {
    const view = renderBoth()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss checklist' }))
    expect(screen.queryByText('Get started')).not.toBeInTheDocument()
    expect(stored().dismissed).toBe(true)

    act(() => setWide(true))
    expect(screen.queryByText('Get started')).not.toBeInTheDocument()
    state.events = [{}]
    view.rerender(
      <>
        <div data-testid="sidebar"><OnboardingChecklistAt width="md-up" /></div>
        <div data-testid="phone"><OnboardingChecklistAt width="below-md" /></div>
      </>,
    )
    expect(stored().dismissed).toBe(true)
    view.unmount()

    renderBoth()
    expect(screen.queryByText('Get started')).not.toBeInTheDocument()
  })

  it('disappears on the phone once every step is done', async () => {
    state.events = [{}]
    state.contacts = [{}]
    state.tasks = [{}]
    renderBoth()

    await waitFor(() => {
      expect(screen.queryByText('Get started')).not.toBeInTheDocument()
    })
  })
})
