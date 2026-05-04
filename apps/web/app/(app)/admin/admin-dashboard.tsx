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
  ChevronDown,
  RefreshCw,
  ExternalLink,
  Shield,
  Globe,
  AlertTriangle,
  Clock,
  CreditCard,
  TrendingUp,
  Mail,
  Loader2,
  Database,
  Zap,
  CheckCircle2,
  XCircle,
  ArrowRight,
} from 'lucide-react'
import { BILLING_API_URL, ETEBASE_SERVER_URL } from '@/app/lib/config'

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
  id: string
  email: string
  createdAt: string
  subscriptionStatus: string
  planId: string | null
  trialEndsAt: string | null
  currentPeriodEnd: string | null
  stripeCustomerId: string | null
  foundingMember: boolean
  emailVerified?: boolean
  wantsProductUpdates?: boolean
  trialPath?: string | null
  earlyAdopter?: boolean
}

interface UserListItem {
  id: string
  email: string
  createdAt: string
  subscriptionStatus: string
  planId: string | null
  foundingMember: boolean
  isAdmin: boolean
  emailVerified?: boolean
  wantsProductUpdates?: boolean
  trialPath?: string | null
  earlyAdopter?: boolean
}

interface EmailRecord {
  id: string
  type: string
  subject: string
  sentAt: string
  status: string
}

interface Subscriber {
  email: string
  source: string
  doiConfirmed: boolean
  wantsUpdates: boolean
  createdAt: string
  unsubscribedAt: string | null
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

// ─── Admin Fetch (auto-refresh on 401) ────────────────────────────────
async function adminFetch(url: string, options?: RequestInit): Promise<Response> {
  const opts = { ...options, credentials: 'include' as const }
  let res = await fetch(url, opts)
  if (res.status === 401) {
    // Try refreshing the token
    const refreshRes = await fetch(`${BILLING_API_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
    if (refreshRes.ok) {
      // Retry the original request
      res = await fetch(url, opts)
    }
  }
  return res
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

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
}

function relativeTime(from: number | null, now: number): string {
  if (from == null) return '—'
  const seconds = Math.max(0, Math.round((now - from) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

// Re-renders every 5s so "Updated Xs ago" labels stay live.
function useNowTick(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

function FreshnessPill({ fetchedAt, ok = true, now }: { fetchedAt: number | null; ok?: boolean; now: number }) {
  const label = relativeTime(fetchedAt, now)
  const stale = fetchedAt != null && now - fetchedAt > 5 * 60_000
  const tone = !ok ? 'text-red-400' : stale ? 'text-amber-500' : 'text-[rgb(var(--muted))]'
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-medium ${tone}`}>
      <Clock className="h-2.5 w-2.5" />
      {label}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { bg: string; text: string; label: string }> = {
    active: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', label: 'Active' },
    trialing: { bg: 'bg-blue-500/10', text: 'text-blue-400', label: 'Trialing' },
    past_due: { bg: 'bg-amber-500/10', text: 'text-amber-500', label: 'Past Due' },
    cancelled: { bg: 'bg-red-500/10', text: 'text-red-400', label: 'Cancelled' },
  }
  const c = config[status] ?? { bg: 'bg-[rgb(var(--border))]', text: 'text-[rgb(var(--muted))]', label: status.replace(/_/g, ' ') }
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${c.bg} ${c.text}`}>
      {c.label}
    </span>
  )
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
      setAuthorized(true)
      setLoading(false)
      return
    }

    async function checkAdmin() {
      try {
        const res = await adminFetch(`${BILLING_API_URL}/account`)
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
        { key: 'payments', label: 'Failed Payments' },
        { key: 'users', label: 'User Lookup' },
        { key: 'subscribers', label: 'Subscribers' },
        { key: 'health', label: 'System Health' },
      ]

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-lg font-semibold text-[rgb(var(--foreground))]">Admin Dashboard</h1>

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-[rgb(var(--border))] -mx-1 px-1">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`whitespace-nowrap px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === key
                ? 'border-[rgb(var(--primary))] text-[rgb(var(--primary))]'
                : 'border-transparent text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (isSelfHosted ? <SelfHostedOverviewTab /> : <OverviewTab onNavigate={setActiveTab} />)}
      {activeTab === 'payments' && !isSelfHosted && <FailedPaymentsTab />}
      {activeTab === 'users' && (isSelfHosted ? <SelfHostedUsersTab /> : <UserLookupTab />)}
      {activeTab === 'subscribers' && !isSelfHosted && <SubscribersTab />}
      {activeTab === 'health' && (isSelfHosted ? <SelfHostedHealthTab /> : <HealthTab />)}
    </div>
  )
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Self-Hosted Tabs
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function SelfHostedOverviewTab() {
  const now = useNowTick()
  const [etebaseStatus, setEtebaseStatus] = useState<'checking' | 'ok' | 'error'>('checking')
  const [etebaseAt, setEtebaseAt] = useState<number | null>(null)

  const pingEtebase = useCallback(async () => {
    setEtebaseStatus('checking')
    try {
      const res = await fetch(ETEBASE_SERVER_URL, { method: 'GET', mode: 'no-cors' })
      setEtebaseStatus(res.ok || res.type === 'opaque' ? 'ok' : 'error')
    } catch {
      setEtebaseStatus('error')
    }
    setEtebaseAt(Date.now())
  }, [])

  useEffect(() => { pingEtebase() }, [pingEtebase])

  const ok = etebaseStatus === 'ok'

  return (
    <div className="space-y-6">
      {/* Status bar */}
      <div className="flex flex-col gap-3 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="flex items-center gap-2">
            <span
              className={`h-2.5 w-2.5 rounded-full ${ok ? 'bg-emerald-500' : etebaseStatus === 'checking' ? 'bg-[rgb(var(--muted))] animate-pulse' : 'bg-red-400'}`}
            />
            <span className={`text-xs font-medium ${ok ? 'text-emerald-500' : etebaseStatus === 'checking' ? 'text-[rgb(var(--muted))]' : 'text-red-400'}`}>
              {ok ? 'Etebase reachable' : etebaseStatus === 'checking' ? 'Checking…' : 'Etebase unreachable'}
            </span>
          </div>
          <FreshnessPill fetchedAt={etebaseAt} ok={ok} now={now} />
        </div>
        <button
          onClick={pingEtebase}
          className="flex items-center gap-1.5 self-start rounded-md border border-[rgb(var(--border))] px-3 py-1.5 text-xs text-[rgb(var(--muted))] hover:border-[rgb(var(--primary))] hover:text-[rgb(var(--foreground))] transition-colors sm:self-auto"
        >
          <RefreshCw className={`h-3 w-3 ${etebaseStatus === 'checking' ? 'animate-spin' : ''}`} /> Re-check
        </button>
      </div>

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
            href="https://github.com/silent-suite/silentsuite"
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
// SaaS Tabs
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ─── Overview Tab — single-pane landing for all admin signals ─────────
function OverviewTab({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const now = useNowTick()

  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(true)
  const [metricsError, setMetricsError] = useState<string | null>(null)
  const [metricsAt, setMetricsAt] = useState<number | null>(null)

  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [healthAt, setHealthAt] = useState<number | null>(null)

  const [events, setEvents] = useState<WebhookEvent[]>([])
  const [eventsTotal, setEventsTotal] = useState<number>(0)
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [eventsAt, setEventsAt] = useState<number | null>(null)

  const [recentSignups, setRecentSignups] = useState<UserListItem[]>([])
  const [recentTotal, setRecentTotal] = useState<number>(0)
  const [recentError, setRecentError] = useState<string | null>(null)
  const [recentAt, setRecentAt] = useState<number | null>(null)

  const [contacts, setContacts] = useState<Subscriber[]>([])
  const [contactsTotal, setContactsTotal] = useState<number>(0)
  const [contactsError, setContactsError] = useState<string | null>(null)
  const [contactsAt, setContactsAt] = useState<number | null>(null)

  const fetchMetrics = useCallback(async () => {
    setMetricsError(null)
    try {
      const res = await adminFetch(`${BILLING_API_URL}/admin/metrics`)
      if (res.ok) {
        setMetrics(await res.json())
        setMetricsAt(Date.now())
      } else {
        setMetricsError('Failed to load metrics')
      }
    } catch {
      setMetricsError('API unavailable')
    }
    setMetricsLoading(false)
  }, [])

  const fetchHealth = useCallback(async () => {
    setHealthError(null)
    try {
      const res = await adminFetch(`${BILLING_API_URL}/admin/health`)
      if (res.ok) {
        setHealth(await res.json())
        setHealthAt(Date.now())
      } else {
        setHealthError('Failed to load health')
      }
    } catch {
      setHealthError('API unavailable')
    }
  }, [])

  const fetchEvents = useCallback(async () => {
    setEventsError(null)
    try {
      const res = await adminFetch(`${BILLING_API_URL}/admin/events?limit=5&offset=0`)
      if (res.ok) {
        const data: EventsPage = await res.json()
        setEvents(data.events)
        setEventsTotal(data.total)
        setEventsAt(Date.now())
      } else {
        setEventsError('Failed to load events')
      }
    } catch {
      setEventsError('API unavailable')
    }
  }, [])

  const fetchRecentSignups = useCallback(async () => {
    setRecentError(null)
    try {
      const res = await adminFetch(`${BILLING_API_URL}/admin/users?limit=5&offset=0`)
      if (res.ok) {
        const data: UsersPage = await res.json()
        setRecentSignups(data.users)
        setRecentTotal(data.total)
        setRecentAt(Date.now())
      } else {
        setRecentError('Failed to load users')
      }
    } catch {
      setRecentError('API unavailable')
    }
  }, [])

  const fetchContacts = useCallback(async () => {
    setContactsError(null)
    try {
      const res = await adminFetch(`${BILLING_API_URL}/admin/contacts?limit=5&offset=0`)
      if (res.ok) {
        const data = await res.json()
        setContacts(data.contacts ?? [])
        setContactsTotal(typeof data.total === 'number' ? data.total : (data.contacts?.length ?? 0))
        setContactsAt(Date.now())
      } else {
        setContactsError('Failed to load contacts')
      }
    } catch {
      setContactsError('API unavailable')
    }
  }, [])

  const refreshAll = useCallback(() => {
    fetchMetrics()
    fetchHealth()
    fetchEvents()
    fetchRecentSignups()
    fetchContacts()
  }, [fetchMetrics, fetchHealth, fetchEvents, fetchRecentSignups, fetchContacts])

  useEffect(() => { refreshAll() }, [refreshAll])

  const totalUsers = metrics
    ? metrics.subscribers.active + metrics.subscribers.trialing + metrics.subscribers.past_due + metrics.subscribers.cancelled + metrics.subscribers.none
    : 0

  const dbOk = health?.database === 'ok'
  const apiUp = !!health || !!metrics
  const pastDue = metrics?.subscribers.past_due ?? 0

  return (
    <div className="space-y-6">
      {/* System Status Bar */}
      <div className="flex flex-col gap-3 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span
              className={`h-2.5 w-2.5 rounded-full ${apiUp ? 'bg-emerald-500' : 'bg-red-400'} ${apiUp ? '' : 'animate-pulse'}`}
              title={apiUp ? 'API up' : 'API unreachable'}
            />
            <span className={`text-xs font-medium ${apiUp ? 'text-emerald-500' : 'text-red-400'}`}>
              {apiUp ? 'API up' : 'API unreachable'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Database className={`h-3.5 w-3.5 ${health == null ? 'text-[rgb(var(--muted))]' : dbOk ? 'text-emerald-500' : 'text-red-400'}`} />
            <span className="text-xs text-[rgb(var(--muted))]">
              DB <span className={health == null ? 'text-[rgb(var(--muted))]' : dbOk ? 'text-emerald-500' : 'text-red-400'}>
                {health == null ? '…' : dbOk ? 'connected' : 'error'}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Zap className="h-3.5 w-3.5 text-[rgb(var(--muted))]" />
            <span className="text-xs text-[rgb(var(--muted))]">
              Uptime <span className="text-[rgb(var(--foreground))]">{health ? formatUptime(health.uptime) : '—'}</span>
            </span>
          </div>
          <FreshnessPill fetchedAt={healthAt} ok={dbOk && !healthError} now={now} />
        </div>
        <button
          onClick={refreshAll}
          className="flex items-center gap-1.5 self-start rounded-md border border-[rgb(var(--border))] px-3 py-1.5 text-xs text-[rgb(var(--muted))] hover:border-[rgb(var(--primary))] hover:text-[rgb(var(--foreground))] transition-colors sm:self-auto"
        >
          <RefreshCw className="h-3 w-3" /> Refresh all
        </button>
      </div>

      {/* Past-due banner — only when there's something to act on */}
      {pastDue > 0 && (
        <button
          onClick={() => onNavigate('payments')}
          className="flex w-full items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-left transition-colors hover:border-amber-500/60"
        >
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" />
          <div className="flex-1">
            <p className="text-sm font-medium text-amber-500">
              {pastDue} past-due {pastDue === 1 ? 'subscriber' : 'subscribers'}
            </p>
            <p className="text-xs text-amber-500/80">Payment failed — likely needs follow-up</p>
          </div>
          <ArrowRight className="h-4 w-4 text-amber-500" />
        </button>
      )}

      {/* KPI tiles */}
      {metricsLoading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 animate-pulse">
              <div className="h-3 w-16 rounded bg-[rgb(var(--border))]" />
              <div className="mt-2 h-7 w-20 rounded bg-[rgb(var(--border))]" />
            </div>
          ))}
        </div>
      ) : metrics ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label="Total Users"
            value={totalUsers}
            icon={<Users className="h-4 w-4 text-[rgb(var(--muted))]" />}
            onDrill={() => onNavigate('users')}
            fetchedAt={metricsAt}
            now={now}
          />
          <KpiTile
            label="Active Subscribers"
            value={metrics.subscribers.active}
            valueClass="text-emerald-500"
            icon={<TrendingUp className="h-4 w-4 text-emerald-500" />}
            onDrill={() => onNavigate('users')}
            fetchedAt={metricsAt}
            now={now}
          />
          <KpiTile
            label="MRR"
            value={`€${metrics.mrr.toFixed(2)}`}
            icon={<DollarSign className="h-4 w-4 text-[rgb(var(--primary))]" />}
            fetchedAt={metricsAt}
            now={now}
          />
          <KpiTile
            label="Signups Today"
            value={metrics.signups.today}
            icon={<UserPlus className="h-4 w-4 text-blue-400" />}
            fetchedAt={metricsAt}
            now={now}
          />
        </div>
      ) : (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">
          {metricsError ?? 'Failed to load metrics'}
        </div>
      )}

      {/* Subscriber funnel + signup velocity */}
      {metrics && (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Subscriber breakdown */}
          <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-5">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-[rgb(var(--primary))]" />
                <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">Subscriber breakdown</h2>
              </div>
              <FreshnessPill fetchedAt={metricsAt} now={now} />
            </div>

            <SubscriberBars subs={metrics.subscribers} />
          </div>

          {/* Signup velocity */}
          <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-5">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <UserPlus className="h-4 w-4 text-blue-400" />
                <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">Signup velocity</h2>
              </div>
              <FreshnessPill fetchedAt={metricsAt} now={now} />
            </div>
            <SignupBars signups={metrics.signups} />
          </div>
        </div>
      )}

      {/* Recent activity: webhook events + recent signups */}
      <div className="grid gap-4 lg:grid-cols-2">
        <RecentEventsCard
          events={events}
          total={eventsTotal}
          error={eventsError}
          fetchedAt={eventsAt}
          now={now}
          onRefresh={fetchEvents}
        />
        <RecentSignupsCard
          users={recentSignups}
          total={recentTotal}
          error={recentError}
          fetchedAt={recentAt}
          now={now}
          onRefresh={fetchRecentSignups}
          onDrill={() => onNavigate('users')}
        />
      </div>

      {/* Contacts / newsletter */}
      <RecentContactsCard
        contacts={contacts}
        total={contactsTotal}
        error={contactsError}
        fetchedAt={contactsAt}
        now={now}
        onRefresh={fetchContacts}
        onDrill={() => onNavigate('subscribers')}
      />
    </div>
  )
}

// ─── Overview helper components ──────────────────────────────────────

function KpiTile({
  label,
  value,
  icon,
  valueClass,
  onDrill,
  fetchedAt,
  now,
}: {
  label: string
  value: string | number
  icon: React.ReactNode
  valueClass?: string
  onDrill?: () => void
  fetchedAt: number | null
  now: number
}) {
  const inner = (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <p className="text-xs text-[rgb(var(--muted))]">{label}</p>
        </div>
        <FreshnessPill fetchedAt={fetchedAt} now={now} />
      </div>
      <p className={`mt-1 text-2xl font-bold ${valueClass ?? 'text-[rgb(var(--foreground))]'}`}>{value}</p>
    </>
  )
  const cls = 'block rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 text-left transition-colors'
  if (onDrill) {
    return (
      <button onClick={onDrill} className={`${cls} hover:border-[rgb(var(--primary))]`}>
        {inner}
      </button>
    )
  }
  return <div className={cls}>{inner}</div>
}

function SubscriberBars({ subs }: { subs: Metrics['subscribers'] }) {
  const total = subs.active + subs.trialing + subs.past_due + subs.cancelled + subs.none
  const rows = [
    { label: 'Active', value: subs.active, bar: 'bg-emerald-500', text: 'text-emerald-500' },
    { label: 'Trialing', value: subs.trialing, bar: 'bg-blue-400', text: 'text-blue-400' },
    { label: 'Past due', value: subs.past_due, bar: 'bg-amber-500', text: 'text-amber-500' },
    { label: 'Cancelled', value: subs.cancelled, bar: 'bg-red-400', text: 'text-red-400' },
    { label: 'No plan', value: subs.none, bar: 'bg-[rgb(var(--muted))]', text: 'text-[rgb(var(--muted))]' },
  ]
  return (
    <div className="space-y-2.5">
      {rows.map(({ label, value, bar, text }) => {
        const pct = total === 0 ? 0 : Math.round((value / total) * 100)
        return (
          <div key={label}>
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span className="text-[rgb(var(--muted))]">{label}</span>
              <span className={`font-semibold ${text}`}>
                {value} <span className="text-[rgb(var(--muted))] font-normal">({pct}%)</span>
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[rgb(var(--background))]">
              <div className={`h-full rounded-full ${bar}`} style={{ width: `${total === 0 ? 0 : Math.max(2, pct)}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function SignupBars({ signups }: { signups: Metrics['signups'] }) {
  const max = Math.max(signups.today, signups.thisWeek, signups.thisMonth, 1)
  const rows = [
    { label: 'Today', value: signups.today },
    { label: 'This week', value: signups.thisWeek },
    { label: 'This month', value: signups.thisMonth },
  ]
  return (
    <div className="space-y-3">
      {rows.map(({ label, value }) => {
        const pct = Math.round((value / max) * 100)
        return (
          <div key={label}>
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span className="text-[rgb(var(--muted))]">{label}</span>
              <span className="font-semibold text-[rgb(var(--foreground))]">{value}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-[rgb(var(--background))]">
              <div
                className="h-full rounded-full bg-blue-400"
                style={{ width: `${value === 0 ? 0 : Math.max(4, pct)}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function RecentEventsCard({
  events,
  total,
  error,
  fetchedAt,
  now,
  onRefresh,
}: {
  events: WebhookEvent[]
  total: number
  error: string | null
  fetchedAt: number | null
  now: number
  onRefresh: () => void
}) {
  return (
    <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-[rgb(var(--muted))]" />
          <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">Recent webhook events</h2>
          <span className="text-xs text-[rgb(var(--muted))]">({total} total)</span>
        </div>
        <div className="flex items-center gap-2">
          <FreshnessPill fetchedAt={fetchedAt} ok={!error} now={now} />
          <button
            onClick={onRefresh}
            className="rounded p-1 text-[rgb(var(--muted))] hover:bg-[rgb(var(--background))] hover:text-[rgb(var(--foreground))]"
            aria-label="Refresh events"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
      </div>

      {error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : fetchedAt == null ? (
        <p className="text-sm text-[rgb(var(--muted))]">Loading…</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-[rgb(var(--muted))]">No webhook events yet</p>
      ) : (
        <ul className="divide-y divide-[rgb(var(--border))]">
          {events.map((event) => {
            const isFailed = event.eventType.includes('payment_failed') || event.eventType.includes('charge.failed')
            return (
              <li key={event.id} className="flex items-center justify-between gap-3 py-2 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  {isFailed ? (
                    <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500/80" />
                  )}
                  <span className={`font-mono truncate ${isFailed ? 'text-red-400 font-medium' : 'text-[rgb(var(--foreground))]'}`}>
                    {event.eventType}
                  </span>
                </div>
                <span className="shrink-0 text-[rgb(var(--muted))]">{relativeTime(new Date(event.processedAt).getTime(), now)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function RecentSignupsCard({
  users,
  total,
  error,
  fetchedAt,
  now,
  onRefresh,
  onDrill,
}: {
  users: UserListItem[]
  total: number
  error: string | null
  fetchedAt: number | null
  now: number
  onRefresh: () => void
  onDrill: () => void
}) {
  return (
    <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UserPlus className="h-4 w-4 text-blue-400" />
          <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">Recent signups</h2>
          <span className="text-xs text-[rgb(var(--muted))]">({total} total)</span>
        </div>
        <div className="flex items-center gap-2">
          <FreshnessPill fetchedAt={fetchedAt} ok={!error} now={now} />
          <button
            onClick={onRefresh}
            className="rounded p-1 text-[rgb(var(--muted))] hover:bg-[rgb(var(--background))] hover:text-[rgb(var(--foreground))]"
            aria-label="Refresh signups"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
      </div>

      {error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : fetchedAt == null ? (
        <p className="text-sm text-[rgb(var(--muted))]">Loading…</p>
      ) : users.length === 0 ? (
        <p className="text-sm text-[rgb(var(--muted))]">No users yet</p>
      ) : (
        <>
          <ul className="divide-y divide-[rgb(var(--border))]">
            {users.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-3 py-2 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <StatusBadge status={u.subscriptionStatus} />
                  <span className="font-mono truncate text-[rgb(var(--foreground))]">{u.email}</span>
                </div>
                <span className="shrink-0 text-[rgb(var(--muted))]">{relativeTime(new Date(u.createdAt).getTime(), now)}</span>
              </li>
            ))}
          </ul>
          <button
            onClick={onDrill}
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[rgb(var(--primary))] hover:underline"
          >
            View all users <ArrowRight className="h-3 w-3" />
          </button>
        </>
      )}
    </div>
  )
}

function RecentContactsCard({
  contacts,
  total,
  error,
  fetchedAt,
  now,
  onRefresh,
  onDrill,
}: {
  contacts: Subscriber[]
  total: number
  error: string | null
  fetchedAt: number | null
  now: number
  onRefresh: () => void
  onDrill: () => void
}) {
  return (
    <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-[rgb(var(--muted))]" />
          <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">Newsletter / contact submissions</h2>
          <span className="text-xs text-[rgb(var(--muted))]">({total} total)</span>
        </div>
        <div className="flex items-center gap-2">
          <FreshnessPill fetchedAt={fetchedAt} ok={!error} now={now} />
          <button
            onClick={onRefresh}
            className="rounded p-1 text-[rgb(var(--muted))] hover:bg-[rgb(var(--background))] hover:text-[rgb(var(--foreground))]"
            aria-label="Refresh contacts"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
      </div>

      {error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : fetchedAt == null ? (
        <p className="text-sm text-[rgb(var(--muted))]">Loading…</p>
      ) : contacts.length === 0 ? (
        <p className="text-sm text-[rgb(var(--muted))]">No contacts yet</p>
      ) : (
        <>
          <ul className="divide-y divide-[rgb(var(--border))]">
            {contacts.map((c) => (
              <li
                key={`${c.email}-${c.createdAt}`}
                className={`flex items-center justify-between gap-3 py-2 text-xs ${c.unsubscribedAt ? 'opacity-60' : ''}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono truncate text-[rgb(var(--foreground))]">{c.email}</span>
                  <span className="shrink-0 rounded-sm bg-[rgb(var(--background))] px-1.5 py-0.5 text-[10px] text-[rgb(var(--muted))] capitalize">
                    {c.source}
                  </span>
                  {c.doiConfirmed && (
                    <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" aria-label="Double opt-in confirmed" />
                  )}
                </div>
                <span className="shrink-0 text-[rgb(var(--muted))]">{relativeTime(new Date(c.createdAt).getTime(), now)}</span>
              </li>
            ))}
          </ul>
          <button
            onClick={onDrill}
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[rgb(var(--primary))] hover:underline"
          >
            View all subscribers <ArrowRight className="h-3 w-3" />
          </button>
        </>
      )}
    </div>
  )
}

// ─── Failed Payments Tab ──────────────────────────────────────────────
function FailedPaymentsTab() {
  const [pastDueUsers, setPastDueUsers] = useState<UserListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchPastDueUsers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Fetch all users and filter to past_due on the client side.
      // The billing API /admin/users endpoint returns paginated results —
      // fetch enough to capture all past_due users.
      const res = await adminFetch(
        `${BILLING_API_URL}/admin/users?limit=200&offset=0`,
      )
      if (res.ok) {
        const data: UsersPage = await res.json()
        setPastDueUsers(data.users.filter(u => u.subscriptionStatus === 'past_due'))
      } else {
        setError('Failed to load user data')
      }
    } catch {
      setError('API unavailable')
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchPastDueUsers() }, [fetchPastDueUsers])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">Failed Payments</h2>
          {!loading && (
            <span className="text-xs text-[rgb(var(--muted))]">({pastDueUsers.length} users)</span>
          )}
        </div>
        <button
          onClick={fetchPastDueUsers}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-[rgb(var(--muted))] hover:bg-[rgb(var(--surface))] hover:text-[rgb(var(--foreground))] transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-400">{error}</p>
      )}

      {loading && pastDueUsers.length === 0 ? (
        <p className="text-sm text-[rgb(var(--muted))]">Loading past due accounts...</p>
      ) : pastDueUsers.length === 0 ? (
        <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10">
            <CreditCard className="h-6 w-6 text-emerald-500" />
          </div>
          <p className="mt-3 text-sm font-medium text-[rgb(var(--foreground))]">No failed payments</p>
          <p className="mt-1 text-xs text-[rgb(var(--muted))]">All subscribers are in good standing</p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Summary banner */}
          <div className="flex items-center gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
            <p className="text-sm text-amber-500">
              <span className="font-medium">{pastDueUsers.length}</span> user{pastDueUsers.length !== 1 ? 's' : ''} with
              past due payments requiring attention
            </p>
          </div>

          {/* Past due users list */}
          <div className="overflow-x-auto rounded-lg border border-[rgb(var(--border))]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[rgb(var(--border))] bg-[rgb(var(--surface))]">
                  <th className="px-4 py-2 text-left text-xs font-medium text-[rgb(var(--muted))]">Email</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-[rgb(var(--muted))]">Status</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-[rgb(var(--muted))]">Plan</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-[rgb(var(--muted))]">Days Past Due</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-[rgb(var(--muted))]">Joined</th>
                </tr>
              </thead>
              <tbody>
                {pastDueUsers.map((u) => (
                  <tr
                    key={u.id}
                    className="border-b border-[rgb(var(--border))] last:border-b-0 bg-amber-500/[0.02] hover:bg-amber-500/5 transition-colors"
                  >
                    <td className="px-4 py-2.5 text-sm text-[rgb(var(--foreground))] font-mono">{u.email}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={u.subscriptionStatus} />
                    </td>
                    <td className="px-4 py-2.5 text-xs text-[rgb(var(--foreground))] capitalize">
                      {u.planId?.replace(/_/g, ' ') ?? '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <Clock className="h-3 w-3 text-amber-500" />
                        <span className="text-xs font-medium text-amber-500">
                          {daysSince(u.createdAt)}d
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-[rgb(var(--muted))]">{formatShortDate(u.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── User Lookup Tab ──────────────────────────────────────────────────
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

  // Table search filter — server-side search via API
  const [tableFilter, setTableFilter] = useState('')
  const [debouncedFilter, setDebouncedFilter] = useState('')

  // Debounce filter input to avoid excessive API calls
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedFilter(tableFilter)
      setUsersOffset(0) // reset to page 1 on new search
    }, 300)
    return () => clearTimeout(timer)
  }, [tableFilter])

  const [usersError, setUsersError] = useState<string | null>(null)

  const fetchUsers = useCallback(async (offset: number, search?: string) => {
    setUsersLoading(true)
    setUsersError(null)
    try {
      const params = new URLSearchParams({
        limit: String(USERS_LIMIT),
        offset: String(offset),
      })
      if (search) params.set('search', search)
      const res = await adminFetch(
        `${BILLING_API_URL}/admin/users?${params}`,
      )
      if (res.ok) {
        setUsersPage(await res.json())
      } else {
        setUsersError('Failed to load users')
      }
    } catch {
      setUsersError('Failed to load users — API unavailable')
    }
    setUsersLoading(false)
  }, [])

  useEffect(() => { fetchUsers(usersOffset, debouncedFilter) }, [fetchUsers, usersOffset, debouncedFilter])

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault()
    if (!searchEmail.trim()) return
    setLookupLoading(true)
    setLookupError(null)
    setLookupUser(null)

    try {
      const res = await adminFetch(
        `${BILLING_API_URL}/admin/users/${encodeURIComponent(searchEmail.trim())}`,
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

  const totalPages = usersPage ? Math.ceil(usersPage.total / USERS_LIMIT) : 0
  const currentPage = Math.floor(usersOffset / USERS_LIMIT) + 1

  // Users are now filtered server-side via the search param
  const filteredUsers = usersPage?.users

  return (
    <div className="space-y-6">
      {/* Email Lookup */}
      <form onSubmit={handleLookup} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[rgb(var(--muted))]" />
          <input
            type="email"
            placeholder="Look up user by exact email address..."
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
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[rgb(var(--primary))]/10">
                <Users className="h-5 w-5 text-[rgb(var(--primary))]" />
              </div>
              <div>
                <p className="text-sm font-medium text-[rgb(var(--foreground))]">{lookupUser.email}</p>
                <p className="text-xs text-[rgb(var(--muted))]">Member since {formatShortDate(lookupUser.createdAt)}</p>
              </div>
            </div>
            <StatusBadge status={lookupUser.subscriptionStatus} />
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <p className="text-xs text-[rgb(var(--muted))]">Plan</p>
              <p className="text-sm text-[rgb(var(--foreground))] capitalize">
                {lookupUser.planId?.replace(/_/g, ' ') ?? 'None'}
              </p>
            </div>
            <div>
              <p className="text-xs text-[rgb(var(--muted))]">Founding Member</p>
              <p className={`text-sm font-medium ${(lookupUser.foundingMember || lookupUser.earlyAdopter) ? 'text-emerald-500' : 'text-[rgb(var(--muted))]'}`}>
                {(lookupUser.foundingMember || lookupUser.earlyAdopter) ? 'Yes' : 'No'}
              </p>
            </div>
            <div>
              <p className="text-xs text-[rgb(var(--muted))]">Email Verified</p>
              <p className="text-sm">{lookupUser.emailVerified === true ? '✅' : lookupUser.emailVerified === false ? '❌' : '—'}</p>
            </div>
            <div>
              <p className="text-xs text-[rgb(var(--muted))]">Product Updates</p>
              <p className="text-sm">{lookupUser.wantsProductUpdates === true ? '✅' : lookupUser.wantsProductUpdates === false ? '❌' : '—'}</p>
            </div>
            {lookupUser.trialPath && (
              <div>
                <p className="text-xs text-[rgb(var(--muted))]">Trial Path</p>
                <p className="text-sm text-[rgb(var(--foreground))]">{lookupUser.trialPath}</p>
              </div>
            )}
            <div>
              <p className="text-xs text-[rgb(var(--muted))]">Early Adopter</p>
              <p className="text-sm">{lookupUser.earlyAdopter === true ? '✅' : lookupUser.earlyAdopter === false ? '❌' : '—'}</p>
            </div>
            {lookupUser.trialEndsAt && (
              <div>
                <p className="text-xs text-[rgb(var(--muted))]">Trial Ends</p>
                <p className="text-sm text-[rgb(var(--foreground))]">{formatShortDate(lookupUser.trialEndsAt)}</p>
              </div>
            )}
            {lookupUser.currentPeriodEnd && (
              <div>
                <p className="text-xs text-[rgb(var(--muted))]">Period End</p>
                <p className="text-sm text-[rgb(var(--foreground))]">{formatShortDate(lookupUser.currentPeriodEnd)}</p>
              </div>
            )}
            {lookupUser.stripeCustomerId && (
              <div>
                <p className="text-xs text-[rgb(var(--muted))]">Stripe Customer</p>
                <p className="text-sm font-mono text-[rgb(var(--foreground))]">{lookupUser.stripeCustomerId}</p>
              </div>
            )}
          </div>

          {/* Emails Sent */}
          {lookupUser.id && <EmailsSentSection userId={lookupUser.id} />}
        </div>
      )}

      {usersError && (
        <p className="text-sm text-red-400">{usersError}</p>
      )}

      {/* All Users Table */}
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))]">
        <div className="flex flex-col gap-3 border-b border-[rgb(var(--border))] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-[rgb(var(--muted))]" />
            <h3 className="text-sm font-medium text-[rgb(var(--foreground))]">All Users</h3>
            {usersPage && (
              <span className="text-xs text-[rgb(var(--muted))]">({usersPage.total} total)</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[rgb(var(--muted))]" />
              <input
                type="text"
                placeholder="Filter by email..."
                value={tableFilter}
                onChange={(e) => setTableFilter(e.target.value)}
                className="w-48 rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] py-1.5 pl-8 pr-3 text-xs text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:border-[rgb(var(--primary))] focus:outline-none focus:ring-1 focus:ring-[rgb(var(--primary))]"
              />
            </div>
            <button
              onClick={() => fetchUsers(usersOffset, debouncedFilter)}
              disabled={usersLoading}
              className="flex items-center gap-1 text-xs text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${usersLoading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[rgb(var(--border))] text-left">
                <th className="px-4 py-2 text-xs font-medium text-[rgb(var(--muted))]">Email</th>
                <th className="px-4 py-2 text-xs font-medium text-[rgb(var(--muted))]">Status</th>
                <th className="px-4 py-2 text-xs font-medium text-[rgb(var(--muted))]">Plan</th>
                <th className="hidden px-4 py-2 text-xs font-medium text-[rgb(var(--muted))] sm:table-cell">Verified</th>
                <th className="hidden px-4 py-2 text-xs font-medium text-[rgb(var(--muted))] sm:table-cell">Updates</th>
                <th className="hidden px-4 py-2 text-xs font-medium text-[rgb(var(--muted))] lg:table-cell">Trial</th>
                <th className="hidden px-4 py-2 text-xs font-medium text-[rgb(var(--muted))] lg:table-cell">Early</th>
                <th className="hidden px-4 py-2 text-xs font-medium text-[rgb(var(--muted))] sm:table-cell">Founding</th>
                <th className="hidden px-4 py-2 text-xs font-medium text-[rgb(var(--muted))] sm:table-cell">Admin</th>
                <th className="px-4 py-2 text-xs font-medium text-[rgb(var(--muted))]">Joined</th>
              </tr>
            </thead>
            <tbody>
              {usersLoading && !usersPage ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-xs text-[rgb(var(--muted))]">
                    Loading users...
                  </td>
                </tr>
              ) : filteredUsers?.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-xs text-[rgb(var(--muted))]">
                    {tableFilter ? 'No users match filter' : 'No users found'}
                  </td>
                </tr>
              ) : (
                filteredUsers?.map((u) => (
                  <tr
                    key={u.id}
                    className="border-b border-[rgb(var(--border))] last:border-b-0 hover:bg-[rgb(var(--background))]/50 transition-colors cursor-pointer"
                    onClick={() => { setSearchEmail(u.email); }}
                  >
                    <td className="px-4 py-2.5 text-sm text-[rgb(var(--foreground))] font-mono truncate max-w-[200px]">{u.email}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={u.subscriptionStatus} />
                    </td>
                    <td className="px-4 py-2.5 text-xs text-[rgb(var(--foreground))] capitalize">
                      {u.planId?.replace(/_/g, ' ') ?? '—'}
                    </td>
                    <td className="hidden px-4 py-2.5 text-center sm:table-cell">
                      <span className="text-xs">{u.emailVerified === true ? '✅' : u.emailVerified === false ? '❌' : '—'}</span>
                    </td>
                    <td className="hidden px-4 py-2.5 text-center sm:table-cell">
                      <span className="text-xs">{u.wantsProductUpdates === true ? '✅' : u.wantsProductUpdates === false ? '❌' : '—'}</span>
                    </td>
                    <td className="hidden px-4 py-2.5 text-xs text-[rgb(var(--foreground))] lg:table-cell">
                      {u.trialPath ?? '—'}
                    </td>
                    <td className="hidden px-4 py-2.5 text-center lg:table-cell">
                      <span className="text-xs">{u.earlyAdopter === true ? '✅' : u.earlyAdopter === false ? '❌' : '—'}</span>
                    </td>
                    <td className="hidden px-4 py-2.5 sm:table-cell">
                      {(u.foundingMember || u.earlyAdopter) ? (
                        <span className="text-xs font-medium text-emerald-500">Yes</span>
                      ) : (
                        <span className="text-xs text-[rgb(var(--muted))]">No</span>
                      )}
                    </td>
                    <td className="hidden px-4 py-2.5 sm:table-cell">
                      {u.isAdmin ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-500">
                          <Shield className="h-3 w-3" /> Yes
                        </span>
                      ) : (
                        <span className="text-xs text-[rgb(var(--muted))]">No</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-[rgb(var(--muted))]">{formatShortDate(u.createdAt)}</td>
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

// ─── Emails Sent Section (per-user expandable) ──────────────────────
function EmailsSentSection({ userId }: { userId: string }) {
  const [expanded, setExpanded] = useState(false)
  const [emails, setEmails] = useState<EmailRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [emailsError, setEmailsError] = useState<string | null>(null)

  const fetchEmails = useCallback(async () => {
    setLoading(true)
    setEmailsError(null)
    try {
      const res = await adminFetch(
        `${BILLING_API_URL}/admin/users/${encodeURIComponent(userId)}/emails`,
      )
      if (res.ok) {
        const data = await res.json()
        setEmails(data.emails ?? data)
      } else {
        setEmailsError('Failed to load emails')
      }
    } catch {
      setEmailsError('Failed to load emails')
    }
    setLoading(false)
    setLoaded(true)
  }, [userId])

  const handleToggle = () => {
    if (!expanded && !loaded) {
      fetchEmails()
    }
    setExpanded(!expanded)
  }

  return (
    <div className="mt-4 border-t border-[rgb(var(--border))] pt-4">
      <button
        onClick={handleToggle}
        className="flex items-center gap-2 text-sm font-medium text-[rgb(var(--foreground))] hover:text-[rgb(var(--primary))] transition-colors"
      >
        <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-0' : '-rotate-90'}`} />
        <Mail className="h-4 w-4 text-[rgb(var(--muted))]" />
        Emails Sent
      </button>
      {expanded && (
        <div className="mt-3">
          {loading ? (
            <div className="flex items-center gap-2 py-4">
              <Loader2 className="h-4 w-4 animate-spin text-[rgb(var(--muted))]" />
              <span className="text-xs text-[rgb(var(--muted))]">Loading emails...</span>
            </div>
          ) : emailsError ? (
            <p className="text-xs text-red-400 py-2">{emailsError}</p>
          ) : emails.length === 0 ? (
            <p className="text-xs text-[rgb(var(--muted))] py-2">No emails sent to this user</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-[rgb(var(--border))]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[rgb(var(--border))] bg-[rgb(var(--surface))]">
                    <th className="px-3 py-1.5 text-left text-xs font-medium text-[rgb(var(--muted))]">Type</th>
                    <th className="px-3 py-1.5 text-left text-xs font-medium text-[rgb(var(--muted))]">Subject</th>
                    <th className="px-3 py-1.5 text-left text-xs font-medium text-[rgb(var(--muted))]">Status</th>
                    <th className="px-3 py-1.5 text-left text-xs font-medium text-[rgb(var(--muted))]">Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {emails.map((em) => (
                    <tr key={em.id} className="border-b border-[rgb(var(--border))] last:border-b-0">
                      <td className="px-3 py-1.5 text-xs font-mono text-[rgb(var(--foreground))]">{em.type}</td>
                      <td className="px-3 py-1.5 text-xs text-[rgb(var(--foreground))]"><div className="truncate max-w-[200px]">{em.subject}</div></td>
                      <td className="px-3 py-1.5">
                        <span className={`text-xs font-medium ${em.status === 'delivered' ? 'text-emerald-500' : em.status === 'bounced' ? 'text-red-400' : 'text-[rgb(var(--muted))]'}`}>
                          {em.status}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-xs text-[rgb(var(--muted))]">{formatDate(em.sentAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Subscribers Tab ─────────────────────────────────────────────────
function SubscribersTab() {
  const [subscribers, setSubscribers] = useState<Subscriber[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [subscribersOffset, setSubscribersOffset] = useState(0)
  const [subscribersTotal, setSubscribersTotal] = useState(0)
  const SUBSCRIBERS_LIMIT = 20

  const fetchSubscribers = useCallback(async (offset: number) => {
    setLoading(true)
    setError(null)
    try {
      const res = await adminFetch(
        `${BILLING_API_URL}/admin/contacts?limit=${SUBSCRIBERS_LIMIT}&offset=${offset}`,
      )
      if (res.ok) {
        const data = await res.json()
        setSubscribers(data.contacts ?? data)
        if (typeof data.total === 'number') setSubscribersTotal(data.total)
        else setSubscribersTotal((data.contacts ?? data).length)
      } else {
        setError('Failed to load subscribers')
      }
    } catch {
      setError('API unavailable')
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchSubscribers(subscribersOffset) }, [fetchSubscribers, subscribersOffset])

  const subscribersTotalPages = Math.ceil(subscribersTotal / SUBSCRIBERS_LIMIT)
  const subscribersCurrentPage = Math.floor(subscribersOffset / SUBSCRIBERS_LIMIT) + 1

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-[rgb(var(--muted))]" />
          <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">Newsletter Subscribers</h2>
          {!loading && (
            <span className="text-xs text-[rgb(var(--muted))]">({subscribersTotal} total)</span>
          )}
        </div>
        <button
          onClick={() => fetchSubscribers(subscribersOffset)}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-[rgb(var(--muted))] hover:bg-[rgb(var(--surface))] hover:text-[rgb(var(--foreground))] transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {loading && subscribers.length === 0 ? (
        <p className="text-sm text-[rgb(var(--muted))]">Loading subscribers...</p>
      ) : subscribers.length === 0 ? (
        <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[rgb(var(--primary))]/10">
            <Mail className="h-6 w-6 text-[rgb(var(--primary))]" />
          </div>
          <p className="mt-3 text-sm font-medium text-[rgb(var(--foreground))]">No subscribers yet</p>
          <p className="mt-1 text-xs text-[rgb(var(--muted))]">Subscribers will appear here once users opt in</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[rgb(var(--border))]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[rgb(var(--border))] bg-[rgb(var(--surface))]">
                <th className="px-4 py-2 text-left text-xs font-medium text-[rgb(var(--muted))]">Email</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-[rgb(var(--muted))]">Source</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-[rgb(var(--muted))]">DOI Confirmed</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-[rgb(var(--muted))]">Updates</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-[rgb(var(--muted))]">Subscribed</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-[rgb(var(--muted))]">Unsubscribed</th>
              </tr>
            </thead>
            <tbody>
              {subscribers.map((s) => (
                <tr
                  key={`${s.email}-${s.createdAt}`}
                  className={`border-b border-[rgb(var(--border))] last:border-b-0 hover:bg-[rgb(var(--background))]/50 transition-colors ${s.unsubscribedAt ? 'opacity-60' : ''}`}
                >
                  <td className="px-4 py-2.5 text-sm font-mono text-[rgb(var(--foreground))]">{s.email}</td>
                  <td className="px-4 py-2.5 text-xs text-[rgb(var(--foreground))] capitalize">{s.source}</td>
                  <td className="px-4 py-2.5 text-center">
                    <span className="text-xs">{s.doiConfirmed ? '✅' : '❌'}</span>
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <span className="text-xs">{s.wantsUpdates ? '✅' : '❌'}</span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-[rgb(var(--muted))]">{formatShortDate(s.createdAt)}</td>
                  <td className="px-4 py-2.5 text-xs text-[rgb(var(--muted))]">{s.unsubscribedAt ? formatShortDate(s.unsubscribedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {subscribersTotalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-[rgb(var(--muted))]">
            Showing {subscribersOffset + 1}–{Math.min(subscribersOffset + SUBSCRIBERS_LIMIT, subscribersTotal)} of {subscribersTotal}
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setSubscribersOffset(Math.max(0, subscribersOffset - SUBSCRIBERS_LIMIT))}
              disabled={subscribersOffset === 0}
              className="rounded p-1 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] disabled:opacity-30 transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="px-2 text-xs text-[rgb(var(--muted))]">{subscribersCurrentPage} / {subscribersTotalPages}</span>
            <button
              onClick={() => setSubscribersOffset(subscribersOffset + SUBSCRIBERS_LIMIT)}
              disabled={subscribersOffset + SUBSCRIBERS_LIMIT >= subscribersTotal}
              className="rounded p-1 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] disabled:opacity-30 transition-colors"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Health Tab ───────────────────────────────────────────────────────
function HealthTab() {
  const [health, setHealth] = useState<Health | null>(null)
  const [healthLoading, setHealthLoading] = useState(true)
  const [lastCheck, setLastCheck] = useState<string | null>(null)

  const fetchHealth = useCallback(async () => {
    setHealthLoading(true)
    try {
      const res = await adminFetch(`${BILLING_API_URL}/admin/health`)
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
