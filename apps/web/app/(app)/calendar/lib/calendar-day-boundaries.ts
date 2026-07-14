export interface ScheduleXDayBoundariesExternal {
  start: string
  end: string
}

export interface ScheduleXDayBoundariesInternal {
  start: number
  end: number
}

export interface ScheduleXWeekLayout {
  startHour: number
  endHour: number
  gridHeight: number
}

export interface RequiredTimedHourBounds {
  startHour: number
  endHour: number
}

const DEFAULT_WEEK_HOUR_HEIGHT = 64
const MIN_WEEK_HOUR_HEIGHT = 48
const MAX_WEEK_HOUR_HEIGHT = 72
const MIN_WEEK_VISIBLE_HOURS = 12
const HOURS_PER_DAY = 24

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function expandDayWindow(startHour: number, endHour: number, targetHours: number): { startHour: number; endHour: number } {
  const visibleHours = Math.max(1, endHour - startHour)
  const extraHours = Math.max(0, targetHours - visibleHours)
  let start = startHour - Math.floor(extraHours / 2)
  let end = endHour + Math.ceil(extraHours / 2)

  if (start < 0) {
    end = Math.min(HOURS_PER_DAY, end - start)
    start = 0
  }

  if (end > HOURS_PER_DAY) {
    start = Math.max(0, start - (end - HOURS_PER_DAY))
    end = HOURS_PER_DAY
  }

  return { startHour: start, endHour: end }
}

export function formatDayBoundary(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

export function hourToScheduleXTimePoint(hour: number): number {
  return hour * 100
}

export function toScheduleXDayBoundariesExternal(
  startHour: number,
  endHour: number,
): ScheduleXDayBoundariesExternal {
  return {
    start: formatDayBoundary(startHour),
    end: formatDayBoundary(endHour),
  }
}

export function toScheduleXDayBoundariesInternal(
  startHour: number,
  endHour: number,
): ScheduleXDayBoundariesInternal {
  return {
    start: hourToScheduleXTimePoint(startHour),
    end: hourToScheduleXTimePoint(endHour),
  }
}

export function getScheduleXWeekLayout(
  startHour: number,
  endHour: number,
  availableHeight = 0,
  requiredBounds?: RequiredTimedHourBounds,
): ScheduleXWeekLayout {
  const preferredStart = clamp(Math.floor(startHour), 0, HOURS_PER_DAY - 1)
  const preferredEnd = clamp(Math.ceil(endHour), preferredStart + 1, HOURS_PER_DAY)
  const requiredStart = Number.isFinite(requiredBounds?.startHour)
    ? clamp(Math.floor(requiredBounds!.startHour), 0, HOURS_PER_DAY - 1)
    : preferredStart
  const requiredEnd = Number.isFinite(requiredBounds?.endHour)
    ? clamp(Math.ceil(requiredBounds!.endHour), requiredStart + 1, HOURS_PER_DAY)
    : preferredEnd
  const effectiveStart = Math.min(preferredStart, requiredStart)
  const effectiveEnd = Math.max(preferredEnd, requiredEnd)
  const preferredHours = effectiveEnd - effectiveStart
  const hoursNeededForHeight = availableHeight > 0 ? Math.ceil(availableHeight / MAX_WEEK_HOUR_HEIGHT) : 0
  const targetHours = Math.min(
    HOURS_PER_DAY,
    Math.max(preferredHours, MIN_WEEK_VISIBLE_HOURS, hoursNeededForHeight),
  )
  const { startHour: expandedStart, endHour: expandedEnd } = expandDayWindow(effectiveStart, effectiveEnd, targetHours)
  const visibleHours = expandedEnd - expandedStart

  const idealHourHeight = availableHeight > 0 ? availableHeight / visibleHours : DEFAULT_WEEK_HOUR_HEIGHT
  const hourHeight = clamp(idealHourHeight, MIN_WEEK_HOUR_HEIGHT, MAX_WEEK_HOUR_HEIGHT)

  return {
    startHour: expandedStart,
    endHour: expandedEnd,
    gridHeight: Math.round(hourHeight * visibleHours),
  }
}

export function getScheduleXWeekGridHeight(startHour: number, endHour: number, availableHeight = 0): number {
  return getScheduleXWeekLayout(startHour, endHour, availableHeight).gridHeight
}
