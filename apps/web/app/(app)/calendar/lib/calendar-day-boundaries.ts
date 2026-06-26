export interface ScheduleXDayBoundariesExternal {
  start: string
  end: string
}

export interface ScheduleXDayBoundariesInternal {
  start: number
  end: number
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
