'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { isSelfHosted } from '@/app/lib/self-hosted'
import {
  Activity,
  Users,
  DollarSign,
  UserPlus,
  Search,
  Server,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  ExternalLink,
  Shield,
  Globe,
} from 'lucide-react'

const BILLING_API_URL =
  process.env.NEXT_PUBLIC_BILLING_API_URL ?? 'http://localhost:3736'

const ETEBASE_SERVER_URL =
  process.env.NEXT_PUBLIC_ETEBASE_SERVER_URL ?? 'http://localhost:3735'

// ─── Types ────────────────────────────────────────────────────────────
interface Metrics {
  subscribers: { trialing: number; active: number; past_due: number; cancelled: number; none: number }
  mrr: number
  signups: { today: number; thisWeek: number; thisMonth: number }
}

interface WebhookEvent {
  id: string
  stripeEventId: string
  eventType: string
  processedAt: string
  payload: string | null
}

interface EventsPage {
  events: WebhookEvent[]
  total: number
  limit: number
  offset: number
}

interface LookedUpUser {
  email: string
  createdAt: string
  subscriptionStatus: string
  planId: string | null
  trialEndsAt: string | null
  currentPeriodEnd: string | null
  stripeCustomerId: string | null
  foundingMember: boolean
}

interface UserListItem {
  id: string
  email: string
  createdAt: string
  subscriptionStatus: string
  planId: string | null
  foundingMember: boolean
  isAdmin: boolean
}

interface UsersPage {
  users: UserListItem[]
  total: number
  limit: number
  offset: number
}

interface Health {
  database: 'ok' | 'error'
  uptime: number
  timestamp: string
}

// ─── Helpers ──────────────────────────────────────────────────────────
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function AdminDashboard() {
  const router = useRouter()
  const [authorized, setAuthorized] = useState(false)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<string>('overview')

  // Check admin access
  useEffect(() => {
    if (isSelfHosted) {
      // In self-hosted mode, all users are admin — skip billing API check
      setAuthorized(true)
      setLoading(false)
      return
    }

    async function checkAdmin() {
      try {
        const res = await fetch(`${BILLING_API_URL}/account`, { credentials: 'include' })
        if (res.ok) {
          const data = await res.json()
          if (data.isAdmin) {
            setAuthorized(true)
          } else {
            router.replace('/calendar')
            return
          }
        } else {
          router.replace('/calendar')
          return
        }
      } catch {
        router.replace('/calendar')
        return
      }
      setLoading(false)
    }
    checkAdmin()
  }, [router])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-[rgb(var(--muted))]">Verifying access...</p>
      </div>
    )
  }

  if (!authorized) return null

  const tabs = isSelfHosted
    ? [
        { key: 'overview', label: 'Overview' },
        { key: 'users', label: 'Users' },
        { key: 'health', label: 'System Health' },
      ]
    : [
        { key: 'overview', label: 'Overview' },
        { key: 'users', label: 'User Lookup' },
        { key: 'health', label: 'System Health' },
      ]

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-lg font-semibold text-[rgb(var(--foreground))]">Admin Dashboard</h1>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[rgb(var(--border))]">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === key
                ? 'border-[rgb(var(--primary))] text-[rgb(var(--primary))]'
                : 'border-transparent text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (isSelfHosted ? <SelfHostedOverviewTab /> : <OverviewTab />)}
      {activeTab === 'users' && (isSelfHosted ? <SelfHostedUsersTab /> : <UserLookupTab />)}
      {activeTab === 'health' && (isSelfHosted ? <SelfHostedHealthTab /> : <HealthTab />)}
    </div>
  )
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Self-Hosted Tabs
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function SelfHostedOverviewTab() {
  return (
    <div className="space-y-6">
      {/* Instance Info Card */}
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[rgb(var(--primary))]/10">
            <Shield className="h-5 w-5 text-[rgb(var(--primary))]" />
          </div>
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Instance Information</p>
            <p className="text-xs text-[rgb(var(--muted))]">SilentSuite self-hosted deployment</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs text-[rgb(var(--muted))]">Version</p>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Self-Hosted</p>
          </div>
          <div>
            <p className="text-xs text-[rgb(var(--muted))]">Deployment Mode</p>
            <p className="text-sm font-medium text-emerald-500">Self-Hosted</p>
          </div>
          <div>
            <p className="text-xs text-[rgb(var(--muted))]">Etebase Server</p>
            <p className="text-sm font-mono text-[rgb(var(--foreground))] break-all">{ETEBASE_SERVER_URL}</p>
          </div>
        </div>
      </div>

      {/* Quick Links */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-[rgb(var(--muted))]" />
          <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">Quick Links</h2>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <a
            href={`${ETEBASE_SERVER_URL}/admin/`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 transition-colors hover:border-[rgb(var(--primary))]"
          >
            <div className="flex items-center gap-3">
              <Server className="h-5 w-5 text-[rgb(var(--primary))]" />
              <div>
                <p className="text-sm font-medium text-[rgb(var(--foreground))]">Etebase Admin</p>
                <p className="text-xs text-[rgb(var(--muted))]">Manage users, collections & server settings</p>
              </div>
            </div>
            <ExternalLink className="h-4 w-4 text-[rgb(var(--muted))]" />
          </a>

          <a
            href="https://github.com/silentsuitehq/silentsuite"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 transition-colors hover:border-[rgb(var(--primary))]"
          >
            <div className="flex items-center gap-3">
              <Globe className="h-5 w-5 text-[rgb(var(--primary))]" />
              <div>
                <p className="text-sm font-medium text-[rgb(var(--foreground))]">Documentation</p>
                <p className="text-xs text-[rgb(var(--muted))]">Setup guides, configuration & troubleshooting</p>
              </div>
            </div>
            <ExternalLink className="h-4 w-4 text-[rgb(var(--muted))]" />
          </a>
        </div>
      </div>
    </div>
  )
}

function SelfHostedUsersTab() {
  const etebaseAdminUrl = `${ETEBASE_SERVER_URL}/admin/`

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[rgb(var(--primary))]/10">
            <Users className="h-5 w-5 text-[rgb(var(--primary))]" />
          </div>
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">User Management</p>
            <p className="text-xs text-[rgb(var(--muted))]">Managed through the Etebase admin panel</p>
          </div>
        </div>

        <p className="text-sm text-[rgb(var(--foreground))] leading-relaxed mb-4">
          Manage users, reset passwords, and handle accounts through the Etebase administration panel.
          The Etebase server handles all authentication and user data storage for your self-hosted instance.
        </p>

        <div className="flex items-center gap-3">
          <a
            href={etebaseAdminUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-[rgb(var(--primary))] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[rgb(var(--primary-hover))]"
          >
            <ExternalLink className="h-4 w-4" />
            Open Etebase Admin Panel
          </a>
        </div>

        <div className="mt-4 rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] p-3">
          <p className="text-xs text-[rgb(var(--muted))]">
            <span className="font-medium text-[rgb(var(--foreground))]">Admin URL:</span>{' '}
            <span className="font-mono">{etebaseAdminUrl}</span>
          </p>
        </div>
      </div>
    </div>
  )
}

function SelfHostedHealthTab() {
  const [etebaseStatus, setEtebaseStatus] = useState<'checking' | 'ok' | 'error'>('checking')
  const [lastCheck, setLastCheck] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)

  const checkEtebase = useCallback(async () => {
    setChecking(true)
    setEtebaseStatus('checking')
    try {
      const res = await fetch(ETEBASE_SERVER_URL, {
        method: 'GET',
        mode: 'no-cors',
      })
      // With no-cors, an opaque response (type "opaque") means the server is reachable
      if (res.ok || res.type === 'opaque') {
        setEtebaseStatus('ok')
      } else {
        setEtebaseStatus('error')
      }
    } catch {
      setEtebaseStatus('error')
    }
    setLastCheck(new Date().toLocaleTimeString())
    setChecking(false)
  }, [])

  useEffect(() => {
    checkEtebase()
  }, [checkEtebase])

  const statusColor = etebaseStatus === 'ok' ? 'text-emerald-500' : etebaseStatus === 'error' ? 'text-red-400' : 'text-[rgb(var(--muted))]'
  const statusBg = etebaseStatus === 'ok' ? 'bg-emerald-500' : etebaseStatus === 'error' ? 'bg-red-400' : 'bg-[rgb(var(--muted))]'
  const statusLabel = etebaseStatus === 'ok' ? 'Connected' : etebaseStatus === 'error' ? 'Unreachable' : 'Checking...'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-[rgb(var(--muted))]" />
          <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">System Health</h2>
        </div>
        <button
          onClick={checkEtebase}
          disabled={checking}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-[rgb(var(--muted))] hover:bg-[rgb(var(--surface))] hover:text-[rgb(var(--foreground))] transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${checking ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {/* Etebase Server */}
        <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4">
          <div className="flex items-center gap-2">
            <div className={`h-2.5 w-2.5 rounded-full ${statusBg} ${etebaseStatus === 'checking' ? 'animate-pulse' : ''}`} />
            <p className="text-xs text-[rgb(var(--muted))]">Etebase Server</p>
          </div>
          <p className={`mt-1 text-sm font-medium ${statusColor}`}>
            {statusLabel}
          </p>
          <p className="mt-0.5 text-xs font-mono text-[rgb(var(--muted))] break-all">
            {ETEBASE_SERVER_URL}
          </p>
        </div>

        {/* Last Check */}
        <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4">
          <div className="flex items-center gap-2">
            <div className="h-2.5 w-2.5 rounded-full bg-blue-400" />
            <p className="text-xs text-[rgb(var(--muted))]">Last Check</p>
          </div>
          <p className="mt-1 text-sm font-medium text-[rgb(var(--foreground))]">
            {lastCheck ?? '—'}
          </p>
        </div>

        {/* Client Info */}
        <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4">
          <div className="flex items-center gap-2">
            <div className="h-2.5 w-2.5 rounded-full bg-blue-400" />
            <p className="text-xs text-[rgb(var(--muted))]">Client</p>
          </div>
          <p className="mt-1 text-sm font-medium text-[rgb(var(--foreground))] truncate" title={typeof navigator !== 'undefined' ? navigator.userAgent : ''}>
            {typeof navigator !== 'undefined' ? navigator.userAgent.split(' ').slice(0, 3).join(' ') : 'N/A'}
          </p>
        </div>
      </div>
    </div>
  )
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SaaS Tabs (existing behavior — unchanged)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ─── Overview Tab (Story 8.2) ─────────────────────────────────────────
function OverviewTab() {
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(true)
  const [events, setEvents] = useState<EventsPage | null>(null)
  const [eventsLoading, setEventsLoading] = useState(true)
  const [eventsOffset, setEventsOffset] = useState(0)
  const eventsLimit = 20

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch(`${BILLING_API_URL}/admin/metrics`, { credentials: 'include' })
      if (res.ok) setMetrics(await res.json())
    } catch { /* API unavailable */ }
    setMetricsLoading(false)
  }, [])

  const fetchEvents = useCallback(async (offset: number) => {
    setEventsLoading(true)
    try {
      const res = await fetch(
        `${BILLING_API_URL}/admin/events?limit=${eventsLimit}&offset=${offset}`,
        { credentials: 'include' },
      )
      if (res.ok) setEvents(await res.json())
    } catch { /* API unavailable */ }
    setEventsLoading(false)
  }, [eventsLimit])

  useEffect(() => { fetchMetrics() }, [fetchMetrics])
  useEffect(() => { fetchEvents(eventsOffset) }, [fetchEvents, eventsOffset])

  return (
    <div className="space-y-6">
      {/* Metrics Cards */}
      {metricsLoading ? (
        <p className="text-sm text-[rgb(var(--muted))]">Loading metrics...</p>
      ) : metrics ? (
        <>
          {/* MRR highlight */}
          <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[rgb(var(--primary))]/10">
                <DollarSign className="h-5 w-5 text-[rgb(var(--primary))]" />
              </div>
              <div>
                <p className="text-xs text-[rgb(var(--muted))]">Monthly Recurring Revenue</p>
                <p className="text-2xl font-bold text-[rgb(var(--foreground))]">
                  ${metrics.mrr.toFixed(2)}
                </p>
              </div>
            </div>
          </div>

          {/* Subscriber counts */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {([
              { label: 'Active', value: metrics.subscribers.active, color: 'text-emerald-500' },
              { label: 'Trialing', value: metrics.subscribers.trialing, color: 'text-blue-400' },
              { label: 'Past Due', value: metrics.subscribers.past_due, color: 'text-amber-500' },
              { label: 'Cancelled', value: metrics.subscribers.cancelled, color: 'text-red-400' },
              { label: 'None', value: metrics.subscribers.none, color: 'text-[rgb(var(--muted))]' },
            ] as const).map(({ label, value, color }) => (
              <div
                key={label}
                className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4"
              >
                <p className="text-xs text-[rgb(var(--muted))]">{label}</p>
                <p className={`text-xl font-semibold ${color}`}>{value}</p>
              </div>
            ))}
          </div>

          {/* Signup counts */}
          <div className="grid grid-cols-3 gap-3">
            {([
              { label: 'Signups Today', value: metrics.signups.today },
              { label: 'This Week', value: metrics.signups.thisWeek },
              { label: 'This Month', value: metrics.signups.thisMonth },
            ] as const).map(({ label, value }) => (
              <div
                key={label}
                className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4"
              >
                <div className="flex items-center gap-2">
                  <UserPlus className="h-4 w-4 text-[rgb(var(--muted))]" />
                  <p className="text-xs text-[rgb(var(--muted))]">{label}</p>
                </div>
                <p className="mt-1 text-xl font-semibold text-[rgb(var(--foreground))]">{value}</p>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="text-sm text-red-400">Failed to load metrics</p>
      )}

      {/* Event Log */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-[rgb(var(--muted))]" />
          <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">Webhook Events</h2>
        </div>

        {eventsLoading ? (
          <p className="text-sm text-[rgb(var(--muted))]">Loading events...</p>
        ) : events && events.events.length > 0 ? (
          <>
            <div className="overflow-x-auto rounded-lg border border-[rgb(var(--border))]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[rgb(var(--border))] bg-[rgb(var(--surface))]">
                    <th className="px-4 py-2 text-left text-xs font-medium text-[rgb(var(--muted))]">Type</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-[rgb(var(--muted))]">Stripe Event</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-[rgb(var(--muted))]">Processed</th>
                  </tr>
                </thead>
                <tbody>
                  {events.events.map((event) => {
                    const isFailed = event.eventType.includes('payment_failed') || event.eventType.includes('charge.failed')
                    return (
                      <tr
                        key={event.id}
                        className={`border-b border-[rgb(var(--border))] last:border-0 ${
                          isFailed ? 'bg-red-500/5' : ''
                        }`}
                      >
                        <td className={`px-4 py-2 font-mono text-xs ${isFailed ? 'text-red-400 font-medium' : 'text-[rgb(var(--foreground))]'}`}>
                          {event.eventType}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-[rgb(var(--muted))]">
                          {event.stripeEventId.slice(0, 24)}...
                        </td>
                        <td className="px-4 py-2 text-xs text-[rgb(var(--muted))]">
                          {formatDate(event.processedAt)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between text-xs text-[rgb(var(--muted))]">
              <span>
                Showing {eventsOffset + 1}–{Math.min(eventsOffset + eventsLimit, events.total)} of {events.total}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setEventsOffset(Math.max(0, eventsOffset - eventsLimit))}
                  disabled={eventsOffset === 0}
                  className="flex items-center gap-1 rounded px-2 py-1 hover:bg-[rgb(var(--surface))] disabled:opacity-30"
                >
                  <ChevronLeft className="h-3 w-3" /> Prev
                </button>
                <button
                  onClick={() => setEventsOffset(eventsOffset + eventsLimit)}
                  disabled={eventsOffset + eventsLimit >= events.total}
                  className="flex items-center gap-1 rounded px-2 py-1 hover:bg-[rgb(var(--surface))] disabled:opacity-30"
                >
                  Next <ChevronRight className="h-3 w-3" />
                </button>
              </div>
            </div>
          </>
        ) : (
          <p className="text-sm text-[rgb(var(--muted))]">No webhook events recorded</p>
        )}
      </div>
    </div>
  )
}

// ─── User Lookup Tab (Story 8.3) ──────────────────────────────────────
function UserLookupTab() {
  const [searchEmail, setSearchEmail] = useState('')
  const [lookupUser, setLookupUser] = useState<LookedUpUser | null>(null)
  const [lookupLoading, setLookupLoading] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)

  // All users table state
  const [usersPage, setUsersPage] = useState<UsersPage | null>(null)
  const [usersLoading, setUsersLoading] = useState(true)
  const [usersOffset, setUsersOffset] = useState(0)
  const USERS_LIMIT = 20

  const fetchUsers = useCallback(async (offset: number) => {
    setUsersLoading(true)
    try {
      const res = await fetch(
        `${BILLING_API_URL}/admin/users?limit=${USERS_LIMIT}&offset=${offset}`,
        { credentials: 'include' },
      )
      if (res.ok) {
        setUsersPage(await res.json())
      }
    } catch { /* ignore */ }
    setUsersLoading(false)
  }, [])

  useEffect(() => { fetchUsers(usersOffset) }, [fetchUsers, usersOffset])

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault()
    if (!searchEmail.trim()) return
    setLookupLoading(true)
    setLookupError(null)
    setLookupUser(null)

    try {
      const res = await fetch(
        `${BILLING_API_URL}/admin/users/${encodeURIComponent(searchEmail.trim())}`,
        { credentials: 'include' },
      )
      if (res.ok) {
        setLookupUser(await res.json())
      } else if (res.status === 404) {
        setLookupError('No user found with that email')
      } else {
        setLookupError('Failed to look up user')
      }
    } catch {
      setLookupError('API unavailable')
    }
    setLookupLoading(false)
  }

  const statusColor = (status: string) => {
    switch (status) {
      case 'active': return 'text-emerald-500'
      case 'trialing': return 'text-blue-400'
      case 'past_due': return 'text-amber-500'
      case 'cancelled': return 'text-red-400'
      default: return 'text-[rgb(var(--muted))]'
    }
  }

  const totalPages = usersPage ? Math.ceil(usersPage.total / USERS_LIMIT) : 0
  const currentPage = Math.floor(usersOffset / USERS_LIMIT) + 1

  return (
    <div className="space-y-6">
      {/* Search */}
      <form onSubmit={handleLookup} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[rgb(var(--muted))]" />
          <input
            type="email"
            placeholder="Search by email address..."
            value={searchEmail}
            onChange={(e) => setSearchEmail(e.target.value)}
            className="w-full rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] py-2 pl-10 pr-4 text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:border-[rgb(var(--primary))] focus:outline-none focus:ring-1 focus:ring-[rgb(var(--primary))]"
          />
        </div>
        <button
          type="submit"
          disabled={lookupLoading || !searchEmail.trim()}
          className="rounded-lg bg-[rgb(var(--primary))] px-4 py-2 text-sm font-medium text-white hover:bg-[rgb(var(--primary-hover))] disabled:opacity-50 transition-colors"
        >
          {lookupLoading ? 'Searching...' : 'Look Up'}
        </button>
      </form>

      {lookupError && (
        <p className="text-sm text-red-400">{lookupError}</p>
      )}

      {lookupUser && (
        <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-5 space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[rgb(var(--primary))]/10">
              <Users className="h-5 w-5 text-[rgb(var(--primary))]" />
            </div>
            <div>
              <p className="text-sm font-medium text-[rgb(var(--foreground))]">{lookupUser.email}</p>
              <p className="text-xs text-[rgb(var(--muted))]">Member since {formatDate(lookupUser.createdAt)}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <p className="text-xs text-[rgb(var(--muted))]">Status</p>
              <p className={`text-sm font-medium capitalize ${statusColor(lookupUser.subscriptionStatus)}`}>
                {lookupUser.subscriptionStatus.replace(/_/g, ' ')}
              </p>
            </div>
            <div>
              <p className="text-xs text-[rgb(var(--muted))]">Plan</p>
              <p className="text-sm text-[rgb(var(--foreground))] capitalize">
                {lookupUser.planId?.replace(/_/g, ' ') ?? 'None'}
              </p>
            </div>
            <div>
              <p className="text-xs text-[rgb(var(--muted))]">Founding Member</p>
              <p className={`text-sm font-medium ${lookupUser.foundingMember ? 'text-emerald-500' : 'text-[rgb(var(--muted))]'}`}>
                {lookupUser.foundingMember ? 'Yes' : 'No'}
              </p>
            </div>
            {lookupUser.trialEndsAt && (
              <div>
                <p className="text-xs text-[rgb(var(--muted))]">Trial Ends</p>
                <p className="text-sm text-[rgb(var(--foreground))]">{formatDate(lookupUser.trialEndsAt)}</p>
              </div>
            )}
            {lookupUser.currentPeriodEnd && (
              <div>
                <p className="text-xs text-[rgb(var(--muted))]">Period End</p>
                <p className="text-sm text-[rgb(var(--foreground))]">{formatDate(lookupUser.currentPeriodEnd)}</p>
              </div>
            )}
            {lookupUser.stripeCustomerId && (
              <div>
                <p className="text-xs text-[rgb(var(--muted))]">Stripe Customer</p>
                <p className="text-sm font-mono text-[rgb(var(--foreground))]">{lookupUser.stripeCustomerId}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* All Users Table */}
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))]">
        <div className="flex items-center justify-between border-b border-[rgb(var(--border))] px-4 py-3">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-[rgb(var(--muted))]" />
            <h3 className="text-sm font-medium text-[rgb(var(--foreground))]">All Users</h3>
            {usersPage && (
              <span className="text-xs text-[rgb(var(--muted))]">({usersPage.total} total)</span>
            )}
          </div>
          <button
            onClick={() => fetchUsers(usersOffset)}
            disabled={usersLoading}
            className="flex items-center gap-1 text-xs text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${usersLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[rgb(var(--border))] text-left">
                <th className="px-4 py-2 text-xs font-medium text-[rgb(var(--muted))]">Email</th>
                <th className="px-4 py-2 text-xs font-medium text-[rgb(var(--muted))]">Status</th>
                <th className="px-4 py-2 text-xs font-medium text-[rgb(var(--muted))]">Plan</th>
                <th className="px-4 py-2 text-xs font-medium text-[rgb(var(--muted))]">Founding</th>
                <th className="px-4 py-2 text-xs font-medium text-[rgb(var(--muted))]">Admin</th>
                <th className="px-4 py-2 text-xs font-medium text-[rgb(var(--muted))]">Joined</th>
              </tr>
            </thead>
            <tbody>
              {usersLoading && !usersPage ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-xs text-[rgb(var(--muted))]">
                    Loading users...
                  </td>
                </tr>
              ) : usersPage?.users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-xs text-[rgb(var(--muted))]">
                    No users found
                  </td>
                </tr>
              ) : (
                usersPage?.users.map((u) => (
                  <tr
                    key={u.id}
                    className="border-b border-[rgb(var(--border))] last:border-b-0 hover:bg-[rgb(var(--background))]/50 transition-colors cursor-pointer"
                    onClick={() => { setSearchEmail(u.email); }}
                  >
                    <td className="px-4 py-2.5 text-sm text-[rgb(var(--foreground))] font-mono">{u.email}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs font-medium capitalize ${statusColor(u.subscriptionStatus)}`}>
                        {u.subscriptionStatus.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-[rgb(var(--foreground))] capitalize">
                      {u.planId?.replace(/_/g, ' ') ?? '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      {u.foundingMember ? (
                        <span className="text-xs font-medium text-emerald-500">Yes</span>
                      ) : (
                        <span className="text-xs text-[rgb(var(--muted))]">No</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {u.isAdmin ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-500">
                          <Shield className="h-3 w-3" /> Yes
                        </span>
                      ) : (
                        <span className="text-xs text-[rgb(var(--muted))]">No</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-[rgb(var(--muted))]">{formatDate(u.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {usersPage && totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-[rgb(var(--border))] px-4 py-3">
            <p className="text-xs text-[rgb(var(--muted))]">
              Showing {usersOffset + 1}–{Math.min(usersOffset + USERS_LIMIT, usersPage.total)} of {usersPage.total}
            </p>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setUsersOffset(Math.max(0, usersOffset - USERS_LIMIT))}
                disabled={usersOffset === 0}
                className="rounded p-1 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] disabled:opacity-30 transition-colors"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="px-2 text-xs text-[rgb(var(--muted))]">{currentPage} / {totalPages}</span>
              <button
                onClick={() => setUsersOffset(usersOffset + USERS_LIMIT)}
                disabled={usersOffset + USERS_LIMIT >= usersPage.total}
                className="rounded p-1 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] disabled:opacity-30 transition-colors"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Health Tab (Story 8.3) ───────────────────────────────────────────
function HealthTab() {
  const [health, setHealth] = useState<Health | null>(null)
  const [healthLoading, setHealthLoading] = useState(true)
  const [lastCheck, setLastCheck] = useState<string | null>(null)

  const fetchHealth = useCallback(async () => {
    setHealthLoading(true)
    try {
      const res = await fetch(`${BILLING_API_URL}/admin/health`, { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setHealth(data)
        setLastCheck(new Date().toLocaleTimeString())
      }
    } catch { /* API unavailable */ }
    setHealthLoading(false)
  }, [])

  useEffect(() => { fetchHealth() }, [fetchHealth])

  const dbColor = health?.database === 'ok' ? 'text-emerald-500' : 'text-red-400'
  const dbBg = health?.database === 'ok' ? 'bg-emerald-500' : 'bg-red-400'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-[rgb(var(--muted))]" />
          <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">System Health</h2>
        </div>
        <button
          onClick={fetchHealth}
          disabled={healthLoading}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-[rgb(var(--muted))] hover:bg-[rgb(var(--surface))] hover:text-[rgb(var(--foreground))] transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${healthLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {healthLoading && !health ? (
        <p className="text-sm text-[rgb(var(--muted))]">Checking health...</p>
      ) : health ? (
        <div className="grid gap-4 sm:grid-cols-3">
          {/* Database */}
          <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4">
            <div className="flex items-center gap-2">
              <div className={`h-2.5 w-2.5 rounded-full ${dbBg}`} />
              <p className="text-xs text-[rgb(var(--muted))]">Database</p>
            </div>
            <p className={`mt-1 text-sm font-medium capitalize ${dbColor}`}>
              {health.database === 'ok' ? 'Connected' : 'Error'}
            </p>
          </div>

          {/* Uptime */}
          <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4">
            <div className="flex items-center gap-2">
              <div className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
              <p className="text-xs text-[rgb(var(--muted))]">Uptime</p>
            </div>
            <p className="mt-1 text-sm font-medium text-[rgb(var(--foreground))]">
              {formatUptime(health.uptime)}
            </p>
          </div>

          {/* Last Check */}
          <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4">
            <div className="flex items-center gap-2">
              <div className="h-2.5 w-2.5 rounded-full bg-blue-400" />
              <p className="text-xs text-[rgb(var(--muted))]">Last Check</p>
            </div>
            <p className="mt-1 text-sm font-medium text-[rgb(var(--foreground))]">
              {lastCheck ?? '—'}
            </p>
          </div>
        </div>
      ) : (
        <p className="text-sm text-red-400">Failed to check system health</p>
      )}
    </div>
  )
}
