import 'temporal-polyfill/global'

/** Convert a JS Date to a Temporal.PlainDate using its local-zone wall-clock components.
 *
 * All-day events are stored as local-midnight Date objects (see `parseICalDateValue`
 * and `EventDialog.buildStartDate`), so reading getFullYear / getMonth / getDate
 * round-trips correctly.
 */
export function dateToPlainDate(date: Date): Temporal.PlainDate {
  return Temporal.PlainDate.from({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  })
}

/** Compute the inclusive end PlainDate to hand to Schedule-X for an all-day event.
 *
 * Our internal `CalendarEvent.endDate` follows the iCal convention where DTEND for
 * a `VALUE=DATE` event is exclusive — the day *after* the last day of the event.
 * Schedule-X v4's date-grid renderer treats `end` as inclusive (it filters days by
 * `day.date >= start && day.date <= end`), so passing the iCal-exclusive value
 * paints the event across one extra day. Subtract one day, but never go below the
 * start date — guards malformed events where DTEND === DTSTART.
 */
export function toAllDayEndPlainDate(startDate: Date, endDate: Date): Temporal.PlainDate {
  const startPd = dateToPlainDate(startDate)
  const endPd = dateToPlainDate(endDate).subtract({ days: 1 })
  return Temporal.PlainDate.compare(endPd, startPd) < 0 ? startPd : endPd
}

/** Return true when a timed event crosses at least one local calendar-day boundary. */
export function isMultiDayTimedRange(startDate: Date, endDate: Date): boolean {
  return (
    startDate.getFullYear() !== endDate.getFullYear() ||
    startDate.getMonth() !== endDate.getMonth() ||
    startDate.getDate() !== endDate.getDate()
  )
}

/** Compute the inclusive end date for rendering a timed multi-day event in month grids.
 *
 * Schedule-X renders spanning bars in the month grid for date-only events. Timed multi-day
 * events should therefore be handed to month view as PlainDate ranges, while week view keeps
 * their exact ZonedDateTime start/end. A timed appointment ending exactly at local midnight
 * does not occupy that final day visually, so clamp the month bar to the prior date.
 */
export function toTimedMonthEndPlainDate(startDate: Date, endDate: Date): Temporal.PlainDate {
  const startPd = dateToPlainDate(startDate)
  let endPd = dateToPlainDate(endDate)

  if (
    endDate.getHours() === 0 &&
    endDate.getMinutes() === 0 &&
    endDate.getSeconds() === 0 &&
    endDate.getMilliseconds() === 0 &&
    Temporal.PlainDate.compare(endPd, startPd) > 0
  ) {
    endPd = endPd.subtract({ days: 1 })
  }

  return Temporal.PlainDate.compare(endPd, startPd) < 0 ? startPd : endPd
}

/** Convert an iCal-exclusive all-day end Date (next-day local-midnight) into a Date
 * representing the inclusive last day at local-midnight.
 *
 * Use Temporal arithmetic rather than `getTime() - 86_400_000`: across a spring-forward
 * boundary the previous calendar day has only 23 hours, and ms subtraction lands the
 * result at 23:00 local on the day before that — wrong calendar day. Used by the
 * EventDialog form-load and subtitle paths so they round-trip consistently with the
 * `buildEndDate` save path.
 */
export function inclusiveAllDayEndDate(exclusiveEndDate: Date): Date {
  const pd = dateToPlainDate(exclusiveEndDate).subtract({ days: 1 })
  return new Date(pd.year, pd.month - 1, pd.day, 0, 0, 0, 0)
}
