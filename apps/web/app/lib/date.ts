import type { DateFormat } from '@silentsuite/core'

function pad(n: number) {
  return String(n).padStart(2, '0')
}

export function formatDate(input: Date | string | number, format: DateFormat = 'system', options?: Intl.DateTimeFormatOptions, locale?: string) {
  const date = typeof input === 'string' || typeof input === 'number' ? new Date(input) : input
  const y = date.getFullYear()
  const m = pad(date.getMonth() + 1)
  const d = pad(date.getDate())

  switch (format) {
    case 'YYYY-MM-DD':
      return `${y}-${m}-${d}`
    case 'DD/MM/YYYY':
      return `${d}/${m}/${y}`
    case 'MM/DD/YYYY':
      return `${m}/${d}/${y}`
    case 'system':
    default:
      return date.toLocaleDateString(locale ?? undefined, options ?? { year: 'numeric', month: 'long', day: 'numeric' })
  }
}

export default formatDate
