import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn(), showSuccessToast: vi.fn(), showWarningToast: vi.fn() }))
const lifecycle = vi.hoisted(() => ({ enable: vi.fn(), disable: vi.fn() }))
vi.mock('@/app/stores/use-toast-store', async (importOriginal) => ({ ...await importOriginal<object>(), ...toastMock }))
vi.mock('@/app/lib/birthday-calendar/session', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/app/lib/birthday-calendar/session')>(),
  enableBirthdayCalendarFromSession: lifecycle.enable,
  disableBirthdayCalendarFromSession: lifecycle.disable,
}))

import { bumpAccountEpoch, getAccountEpoch } from '@/app/lib/account-epoch'
import { useBirthdayMarkerStore } from '@/app/lib/birthday-calendar/markers'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { CalendarListPanel } from '../CalendarListPanel'

const ON = 'Turn on Birthdays calendar'
const OFF = 'Turn off Birthdays calendar'

function setup({ active = [] as string[], own = [] as string[] } = {}) {
  useEtebaseStore.setState({ accountFingerprint: 'fp-a', createCollection: vi.fn(), deleteCollection: vi.fn(), updateCollectionMeta: vi.fn() } as never)
  useAuthStore.setState({ canWrite: () => true } as never)
  useCalendarListStore.setState({
    calendars: [
      { id: 'cal-1', name: 'Personal', color: '#10b981', visible: true },
      { id: 'bday-1', name: 'Birthdays', color: '#f59e0b', visible: true },
    ],
    defaultCalendarId: 'cal-1',
  })
  useBirthdayMarkerStore.setState({ snapshot: { epoch: getAccountEpoch(), fingerprint: 'fp-a', activeIds: active, qualifyingIds: own } as never })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('CalendarListPanel Birthdays control (#738)', () => {
  beforeEach(() => {
    lifecycle.enable.mockReset()
    lifecycle.disable.mockReset()
    Object.values(toastMock).forEach((mock) => mock.mockReset())
  })

  it('turns generation on from its own control and reports success', async () => {
    setup()
    lifecycle.enable.mockResolvedValue({ status: 'done' })
    render(<CalendarListPanel />)
    fireEvent.click(screen.getByRole('button', { name: ON }))
    await waitFor(() => expect(lifecycle.enable).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(toastMock.showSuccessToast).toHaveBeenCalledTimes(1))
    expect(toastMock.showErrorToast).not.toHaveBeenCalled()
  })

  it('does not report generation as on just because a shared managed calendar exists', () => {
    setup({ active: ['bday-1'], own: [] })
    render(<CalendarListPanel />)
    expect(screen.getByRole('button', { name: ON })).toBeTruthy()
    expect(screen.queryByRole('button', { name: OFF })).toBeNull()
  })

  it('asks before turning off, says what is removed and kept, and does nothing when declined', async () => {
    setup({ active: ['bday-1'], own: ['bday-1'] })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<CalendarListPanel />)
    fireEvent.click(screen.getByRole('button', { name: OFF }))
    expect(confirm).toHaveBeenCalledTimes(1)
    const message = String(confirm.mock.calls[0]![0])
    expect(message).toMatch(/birthday events generated from your contacts will be removed/i)
    expect(message).toMatch(/events you added yourself are kept/i)
    expect(lifecycle.disable).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('turns off when confirmed, and a failure never claims it is off', async () => {
    setup({ active: ['bday-1'], own: ['bday-1'] })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    lifecycle.disable.mockResolvedValueOnce({ status: 'failed' }).mockResolvedValueOnce({ status: 'done' })
    render(<CalendarListPanel />)

    fireEvent.click(screen.getByRole('button', { name: OFF }))
    await waitFor(() => expect(toastMock.showErrorToast).toHaveBeenCalledTimes(1))
    expect(toastMock.showSuccessToast).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: OFF }))
    await waitFor(() => expect(toastMock.showSuccessToast).toHaveBeenCalledTimes(1))
    expect(lifecycle.disable).toHaveBeenCalledTimes(2)
    confirm.mockRestore()
  })

  it('reports skipped (offline or read-only) without claiming a change', async () => {
    setup()
    lifecycle.enable.mockResolvedValue({ status: 'skipped' })
    render(<CalendarListPanel />)
    fireEvent.click(screen.getByRole('button', { name: ON }))
    await waitFor(() => expect(toastMock.showWarningToast).toHaveBeenCalledTimes(1))
    expect(toastMock.showSuccessToast).not.toHaveBeenCalled()
  })

  it('hiding the Birthdays calendar only changes visibility', () => {
    setup({ active: ['bday-1'], own: ['bday-1'] })
    render(<CalendarListPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide Birthdays' }))
    expect(useCalendarListStore.getState().calendars.find((c) => c.id === 'bday-1')?.visible).toBe(false)
    expect(lifecycle.enable).not.toHaveBeenCalled()
    expect(lifecycle.disable).not.toHaveBeenCalled()
  })

  it('a managed calendar cannot be made the default or deleted around the safe turn-off', () => {
    setup({ active: ['bday-1'], own: ['bday-1'] })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<CalendarListPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Birthdays actions' }))
    const deleteItem = screen.getByRole('menuitem', { name: /delete calendar/i })
    expect((deleteItem as HTMLButtonElement).disabled).toBe(true)
    const setDefault = screen.getAllByRole('menuitem').find((item) => /default/i.test(item.textContent ?? ''))
    expect(setDefault).toBeDefined()
    fireEvent.click(setDefault!)
    expect(useCalendarListStore.getState().defaultCalendarId).toBe('cal-1')
    expect(useEtebaseStore.getState().deleteCollection).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('the mobile collection sheet embeds the real panel and its working Birthdays control', async () => {
    setup()
    lifecycle.enable.mockResolvedValue({ status: 'done' })
    const { MobileCollectionSheet } = await import('../MobileCollectionSheet')
    render(<MobileCollectionSheet type="calendar" open onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: ON }))
    await waitFor(() => expect(lifecycle.enable).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Hide Birthdays' })).toBeTruthy()
  })

  it('an action that finishes after the account changed shows nothing in the new account', async () => {
    setup()
    const pending = deferred<{ status: string }>()
    lifecycle.enable.mockReturnValue(pending.promise)
    render(<CalendarListPanel />)
    fireEvent.click(screen.getByRole('button', { name: ON }))
    expect((screen.getByRole('button', { name: ON }) as HTMLButtonElement).disabled).toBe(true)

    act(() => {
      bumpAccountEpoch()
      useEtebaseStore.setState({ accountFingerprint: 'fp-b' } as never)
    })
    expect((screen.getByRole('button', { name: ON }) as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { pending.resolve({ status: 'done' }) })

    expect(toastMock.showSuccessToast).not.toHaveBeenCalled()
    expect(toastMock.showErrorToast).not.toHaveBeenCalled()
  })
})
