import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { CalendarTimezoneNote } from '../CalendarTimezoneNote'

const device = vi.hoisted(() => ({ tz: 'Europe/Berlin' }))

vi.mock('@/app/lib/tz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/lib/tz')>()),
  deviceTimezone: () => device.tz,
}))

const winter = new Date(Date.UTC(2026, 0, 15, 12))

describe('CalendarTimezoneNote', () => {
  it('names the display zone quietly when the device shows the same time', () => {
    device.tz = 'Europe/Berlin'
    renderWithIntl(<CalendarTimezoneNote displayTz="Europe/Berlin" refDate={winter} />)
    const note = screen.getByText('Times in Europe/Berlin (GMT+1)')
    expect(note.className).toContain('text-[rgb(var(--muted))]')
    expect(note.className).not.toContain('amber')
  })

  it('also names the device zone, highlighted, when it differs', () => {
    device.tz = 'America/New_York'
    renderWithIntl(<CalendarTimezoneNote displayTz="Europe/Berlin" refDate={winter} />)
    const note = screen.getByText('Times in Europe/Berlin (GMT+1), this device: America/New York (EST)')
    expect(note.className).toContain('amber')
  })
})
