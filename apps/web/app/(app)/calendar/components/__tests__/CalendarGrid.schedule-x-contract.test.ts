import 'temporal-polyfill/global'
import { createCalendar, createViewWeek } from '@schedule-x/calendar'
import { describe, expect, it } from 'vitest'

describe('pinned Schedule-X locale contract', () => {
  it('constructs a synchronous mutable locale signal in both directions', () => {
    const calendar = createCalendar({
      views: [createViewWeek()],
      locale: 'en-US',
    }) as any

    expect(calendar.$app.config.locale.value).toBe('en-US')
    calendar.$app.config.locale.value = 'en-GB'
    expect(calendar.$app.config.locale.value).toBe('en-GB')
    calendar.$app.config.locale.value = 'en-US'
    expect(calendar.$app.config.locale.value).toBe('en-US')
  })
})
