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
