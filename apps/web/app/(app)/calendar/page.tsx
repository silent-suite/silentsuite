'use client'

import dynamic from 'next/dynamic'

const CalendarWorkspace = dynamic(() => import('./calendar-workspace'), { ssr: false })

export default function CalendarPage() {
  return <CalendarWorkspace />
}
