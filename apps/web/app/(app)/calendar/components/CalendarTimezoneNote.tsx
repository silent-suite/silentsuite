'use client'

import { useTranslations } from 'next-intl'
import { deviceTimezone, timezoneDisplayName, zonesShowDifferentTimes } from '@/app/lib/tz'

interface CalendarTimezoneNoteProps {
  /** Zone the calendar shows times in (the synced preference, or the device zone). */
  displayTz: string
  /** Date the calendar is showing; picks the right offset around DST changes. */
  refDate: Date
  className?: string
}

/** Quiet "Times in <zone>" note; names the device zone too when its clock reads differently. */
export function CalendarTimezoneNote({ displayTz, refDate, className = '' }: CalendarTimezoneNoteProps) {
  const t = useTranslations('CalendarTimezone')
  const deviceTz = deviceTimezone()
  const zone = timezoneDisplayName(displayTz, refDate)
  const differs = zonesShowDifferentTimes(displayTz, deviceTz, refDate)
  const text = differs
    ? t('timesInWithDevice', { zone, device: timezoneDisplayName(deviceTz, refDate) })
    : t('timesIn', { zone })
  return (
    <span
      className={`min-w-0 truncate text-xs ${
        differs ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-[rgb(var(--muted))]'
      } ${className}`}
      title={text}
    >
      {text}
    </span>
  )
}
