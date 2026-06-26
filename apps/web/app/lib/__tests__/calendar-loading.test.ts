import { describe, expect, it } from 'vitest'
import { partitionCalendarItemsForFastPaint, type CalendarContentItem } from '../calendar-loading'

function item(uid: string, content: string): CalendarContentItem {
  return { uid, collectionUid: 'cal-1', content }
}

describe('partitionCalendarItemsForFastPaint', () => {
  const now = new Date('2026-06-25T12:00:00Z')

  it('loads current and future events before old history', () => {
    const old = item('old', 'BEGIN:VEVENT\nDTSTART:20200101T090000Z\nDTEND:20200101T100000Z\nEND:VEVENT')
    const recent = item('recent', 'BEGIN:VEVENT\nDTSTART:20260620T090000Z\nDTEND:20260620T100000Z\nEND:VEVENT')
    const future = item('future', 'BEGIN:VEVENT\nDTSTART:20260701T090000Z\nDTEND:20260701T100000Z\nEND:VEVENT')

    const { priority, backlog } = partitionCalendarItemsForFastPaint([old, recent, future], now)

    expect(priority.map((event) => event.uid)).toEqual(['recent', 'future'])
    expect(backlog.map((event) => event.uid)).toEqual(['old'])
  })

  it('keeps active recurring events in the fast path even if the master starts in the past', () => {
    const activeRecurring = item(
      'recurring-active',
      'BEGIN:VEVENT\nDTSTART:20200101T090000Z\nDTEND:20200101T100000Z\nRRULE:FREQ=DAILY\nEND:VEVENT',
    )
    const endedRecurring = item(
      'recurring-ended',
      'BEGIN:VEVENT\nDTSTART:20200101T090000Z\nDTEND:20200101T100000Z\nRRULE:FREQ=DAILY;UNTIL=20200131T090000Z\nEND:VEVENT',
    )

    const { priority, backlog } = partitionCalendarItemsForFastPaint([endedRecurring, activeRecurring], now)

    expect(priority.map((event) => event.uid)).toEqual(['recurring-active'])
    expect(backlog.map((event) => event.uid)).toEqual(['recurring-ended'])
  })

  it('uses folded DTSTART/DTEND lines and TZID parameters when classifying events', () => {
    const foldedFuture = item(
      'folded-future',
      'BEGIN:VEVENT\nDTSTART;TZID=America/New_York:20260701T090000\nDTEND;TZID=America/New_York:20260701T100000\nEND:VEVENT',
    )
    const foldedOld = item(
      'folded-old',
      'BEGIN:VEVENT\nDTSTART;VALUE=DATE:20200101\nDTEND;VALUE=DATE:\n 20200102\nEND:VEVENT',
    )

    const { priority, backlog } = partitionCalendarItemsForFastPaint([foldedOld, foldedFuture], now)

    expect(priority.map((event) => event.uid)).toEqual(['folded-future'])
    expect(backlog.map((event) => event.uid)).toEqual(['folded-old'])
  })

  it('keeps malformed events in the fast path so full deserialization can report them', () => {
    const malformed = item('malformed', 'BEGIN:VEVENT\nSUMMARY:Missing DTSTART\nEND:VEVENT')

    const { priority, backlog } = partitionCalendarItemsForFastPaint([malformed], now)

    expect(priority.map((event) => event.uid)).toEqual(['malformed'])
    expect(backlog).toEqual([])
  })
})
