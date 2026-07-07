export interface ScheduleXDayBoundariesExternal {
  start: string
  end: string
}

export interface ScheduleXDayBoundariesInternal {
  start: number
  end: number
}

const MIN_WEEK_GRID_HEIGHT = 800
const WEEK_GRID_HOUR_HEIGHT = 112

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

export function getScheduleXWeekGridHeight(startHour: number, endHour: number): number {
  const visibleHours = Math.max(1, endHour - startHour)
  return Math.max(MIN_WEEK_GRID_HEIGHT, visibleHours * WEEK_GRID_HOUR_HEIGHT)
}
