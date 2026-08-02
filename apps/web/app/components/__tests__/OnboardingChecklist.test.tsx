import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  events: [] as unknown[],
  contacts: [] as unknown[],
  tasks: [] as unknown[],
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

import { OnboardingChecklist } from '../OnboardingChecklist'

describe('OnboardingChecklist', () => {
  beforeEach(() => {
    localStorage.clear()
    state.events = []
    state.contacts = []
    state.tasks = []
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
})
