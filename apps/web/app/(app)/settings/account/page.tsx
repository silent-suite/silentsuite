'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { usePreferencesStore } from '@/app/stores/use-preferences-store'
import { formatDate } from '@/app/lib/date'
import { isSelfHosted, isCustomServer } from '@/app/lib/self-hosted'
import { BILLING_API_URL, ETEBASE_SERVER_URL } from '@/app/lib/config'
import type { DayBoundaryHour, DefaultReminder } from '@silentsuite/core'

interface AccountDetails {
  id: string
  email: string
  isAdmin: boolean
  provisioningStatus: string
  createdAt: string
}

export default function AccountPage() {
  const { user } = useAuthStore()
  const [account, setAccount] = useState<AccountDetails | null>(null)
  const [loading, setLoading] = useState(true)

  const timeFormat = usePreferencesStore((s) => s.timeFormat)
  const firstDayOfWeek = usePreferencesStore((s) => s.firstDayOfWeek)
  const defaultReminder = usePreferencesStore((s) => s.defaultReminder)
  const notificationSound = usePreferencesStore((s) => s.notificationSound)
  const defaultTimezone = usePreferencesStore((s) => s.defaultTimezone)
  const dateFormat = usePreferencesStore((s) => s.dateFormat)
  const dayStartHour = usePreferencesStore((s) => s.dayStartHour)
  const dayEndHour = usePreferencesStore((s) => s.dayEndHour)
  const setDateFormat = usePreferencesStore((s) => s.setDateFormat)
  const setTimeFormat = usePreferencesStore((s) => s.setTimeFormat)
  const setFirstDayOfWeek = usePreferencesStore((s) => s.setFirstDayOfWeek)
  const setDefaultReminder = usePreferencesStore((s) => s.setDefaultReminder)
  const setNotificationSound = usePreferencesStore((s) => s.setNotificationSound)
  const setDefaultTimezone = usePreferencesStore((s) => s.setDefaultTimezone)
  const setDayBounds = usePreferencesStore((s) => s.setDayBounds)

  const hourOptions = useMemo(() => Array.from({ length: 25 }, (_, hour) => hour as DayBoundaryHour), [])

  const allTimezones = useMemo(() => {
    try {
      return Intl.supportedValuesOf('timeZone')
    } catch {
      return ['UTC']
    }
  }, [])

  useEffect(() => {
    if (isSelfHosted) {
      setLoading(false)
      return
    }
    async function fetchAccount() {
      try {
        const res = await fetch(`${BILLING_API_URL}/account`, {
          credentials: 'include',
        })
        if (res.ok) {
          setAccount(await res.json())
        }
      } catch {
        // API may not be running in dev
      } finally {
        setLoading(false)
      }
    }
    fetchAccount()
  }, [])

  const connectedServer = useMemo(() => {
    const stored = localStorage.getItem('silentsuite-server-url')
    if (isSelfHosted || isCustomServer(stored ?? undefined)) {
      return stored ?? ETEBASE_SERVER_URL ?? 'Self-Hosted'
    }
    return 'silentsuite.io'
  }, [])

  const email = account?.email ?? user?.email ?? '—'
  const createdAt = account?.createdAt
    ? (() => {
        const d = new Date(account.createdAt)
        return dateFormat === 'system'
          ? formatDate(d, 'system', { year: 'numeric', month: 'long', day: 'numeric' })
          : formatDate(d, dateFormat)
      })()
    : '—'
  const status = isSelfHosted ? 'Self-Hosted' : (account?.provisioningStatus ?? 'Free trial')

  return (
    <div className="space-y-6">
      {loading ? (
        <p className="text-sm text-[rgb(var(--muted))]">Loading account details...</p>
      ) : (
        <>
          <section className="rounded-lg border border-[rgb(var(--border))] p-4 space-y-4">
            <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">Profile</h2>

            <div className="space-y-3">
              <div>
                <p className="text-xs text-[rgb(var(--muted))]">Email address</p>
                <p className="text-sm text-[rgb(var(--foreground))]">{email}</p>
              </div>

              <div>
                <p className="text-xs text-[rgb(var(--muted))]">Member since</p>
                <p className="text-sm text-[rgb(var(--foreground))]">{createdAt}</p>
              </div>

              <div>
                <p className="text-xs text-[rgb(var(--muted))]">Plan</p>
                <p className="text-sm text-[rgb(var(--foreground))] capitalize">{status.replace(/_/g, ' ')}</p>
              </div>

              <div>
                <p className="text-xs text-[rgb(var(--muted))]">Connected server</p>
                <p className="text-sm text-[rgb(var(--foreground))]">{connectedServer}</p>
              </div>
            </div>
          </section>

          {/* ── Preferences ── */}
          <section className="rounded-lg border border-[rgb(var(--border))] p-4 space-y-4">
            <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">Preferences</h2>

            <div className="space-y-4">
              {/* Time Format */}
              <div className="space-y-2">
                <p className="text-xs text-[rgb(var(--muted))]">Time format</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setTimeFormat('12h')}
                    className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${
                      timeFormat === '12h'
                        ? 'border-emerald-500 bg-emerald-600/15 text-emerald-400'
                        : 'border-[rgb(var(--border))] bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] hover:border-[rgb(var(--muted))]'
                    }`}
                  >
                    <span className="font-medium">12-hour</span>
                    <span className="ml-2 text-xs opacity-70">7:00 PM</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setTimeFormat('24h')}
                    className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${
                      timeFormat === '24h'
                        ? 'border-emerald-500 bg-emerald-600/15 text-emerald-400'
                        : 'border-[rgb(var(--border))] bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] hover:border-[rgb(var(--muted))]'
                    }`}
                  >
                    <span className="font-medium">24-hour</span>
                    <span className="ml-2 text-xs opacity-70">19:00</span>
                  </button>
                </div>
              </div>

              {/* First Day of Week */}
              <div className="space-y-2">
                <p className="text-xs text-[rgb(var(--muted))]">First day of week</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setFirstDayOfWeek('monday')}
                    className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                      firstDayOfWeek === 'monday'
                        ? 'border-emerald-500 bg-emerald-600/15 text-emerald-400'
                        : 'border-[rgb(var(--border))] bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] hover:border-[rgb(var(--muted))]'
                    }`}
                  >
                    Monday
                  </button>
                  <button
                    type="button"
                    onClick={() => setFirstDayOfWeek('sunday')}
                    className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                      firstDayOfWeek === 'sunday'
                        ? 'border-emerald-500 bg-emerald-600/15 text-emerald-400'
                        : 'border-[rgb(var(--border))] bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] hover:border-[rgb(var(--muted))]'
                    }`}
                  >
                    Sunday
                  </button>
                </div>
              </div>

              {/* Visible Day Bounds */}
              <div className="space-y-2">
                <p className="text-xs text-[rgb(var(--muted))]">Visible calendar day</p>
                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1 text-xs text-[rgb(var(--muted))]">
                    <span>Start</span>
                    <select
                      value={dayStartHour}
                      onChange={(e) => setDayBounds(Number(e.target.value) as DayBoundaryHour, dayEndHour)}
                      className="w-full rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    >
                      {hourOptions.slice(0, 24).map((hour) => (
                        <option key={hour} value={hour} disabled={hour >= dayEndHour}>
                          {String(hour).padStart(2, '0')}:00
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-xs text-[rgb(var(--muted))]">
                    <span>End</span>
                    <select
                      value={dayEndHour}
                      onChange={(e) => setDayBounds(dayStartHour, Number(e.target.value) as DayBoundaryHour)}
                      className="w-full rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    >
                      {hourOptions.slice(1).map((hour) => (
                        <option key={hour} value={hour} disabled={hour <= dayStartHour}>
                          {String(hour).padStart(2, '0')}:00
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="text-xs text-[rgb(var(--muted))]">Default is the full 00:00–24:00 day.</p>
              </div>

              {/* Default Reminder */}
              <div className="space-y-2">
                <p className="text-xs text-[rgb(var(--muted))]">Default reminder for new events</p>
                <select
                  value={defaultReminder}
                  onChange={(e) => setDefaultReminder(e.target.value as DefaultReminder)}
                  className="w-full rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="none">None</option>
                  <option value="5">5 minutes before</option>
                  <option value="15">15 minutes before</option>
                  <option value="30">30 minutes before</option>
                  <option value="60">1 hour before</option>
                  <option value="1440">1 day before</option>
                </select>
              </div>

              {/* Default Timezone */}
              <div className="space-y-2">
                <p className="text-xs text-[rgb(var(--muted))]">Default timezone</p>
                <select
                  value={defaultTimezone}
                  onChange={(e) => setDefaultTimezone(e.target.value)}
                  className="w-full rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  {allTimezones.map((tz) => (
                    <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>
                  ))}
                </select>
              </div>

              {/* Date Format */}
              <div className="space-y-2">
                <p className="text-xs text-[rgb(var(--muted))]">Date format</p>
                <select
                  value={dateFormat}
                  onChange={(e) => setDateFormat(e.target.value as import('@silentsuite/core').DateFormat)}
                  className="w-full rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="system">System locale</option>
                  <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                  <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                  <option value="DD.MM.YYYY">DD.MM.YYYY</option>
                  <option value="YYYY/MM/DD">YYYY/MM/DD</option>
                  <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                </select>
              </div>

              {/* Notification Sound */}
              <div className="space-y-2">
                <p className="text-xs text-[rgb(var(--muted))]">Notification sound</p>
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-sm text-[rgb(var(--foreground))]">
                    Play sound when reminders fire
                  </span>
                  <input
                    type="checkbox"
                    checked={notificationSound}
                    onChange={(e) => setNotificationSound(e.target.checked)}
                    className="h-4 w-4 rounded border-[rgb(var(--border))] accent-emerald-500"
                  />
                </label>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
