'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { SettingsNav } from './settings-nav'

// Matches Tailwind's `lg`, where the layout shows the settings rail.
const RAIL_QUERY = '(min-width: 1024px)'

export default function SettingsPage() {
  const router = useRouter()

  // With the rail visible, the overview list adds nothing; open Account instead.
  useEffect(() => {
    const mq = window.matchMedia(RAIL_QUERY)
    const openDefault = () => {
      if (mq.matches) router.replace('/settings/account')
    }
    openDefault()
    mq.addEventListener('change', openDefault)
    return () => mq.removeEventListener('change', openDefault)
  }, [router])

  return (
    <div className="max-w-2xl lg:hidden">
      <SettingsNav variant="overview" pathname="/settings" />
    </div>
  )
}
