'use client'

import { useCallback, useEffect, useState } from 'react'
import { Activity, ExternalLink, Globe, RefreshCw, Server, Shield, Users } from 'lucide-react'
import { ETEBASE_SERVER_URL } from '@/app/lib/config'
import { isSelfHosted } from '@/app/lib/self-hosted'

const PRIVATE_ADMIN_URL = 'https://silentsuite.io/admin'

export default function AdminPage() {
  if (!isSelfHosted) return <PrivateAdminRedirect />
  return <SelfHostedAdmin />
}

function PrivateAdminRedirect() {
  useEffect(() => {
    window.location.replace(PRIVATE_ADMIN_URL)
  }, [])

  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-6 text-center">
        <Shield className="mx-auto h-8 w-8 text-[rgb(var(--primary))]" />
        <p className="mt-3 text-sm font-medium text-[rgb(var(--foreground))]">Opening private admin dashboard...</p>
        <a href={PRIVATE_ADMIN_URL} className="mt-2 inline-flex text-xs font-medium text-[rgb(var(--primary))] hover:underline">
          Continue manually
        </a>
      </div>
    </div>
  )
}

function SelfHostedAdmin() {
  const [status, setStatus] = useState<'checking' | 'ok' | 'error'>('checking')
  const [lastCheck, setLastCheck] = useState<string | null>(null)
  const etebaseAdminUrl = `${ETEBASE_SERVER_URL}/admin/`

  const checkEtebase = useCallback(async () => {
    setStatus('checking')
    try {
      const res = await fetch(ETEBASE_SERVER_URL, { method: 'GET', mode: 'no-cors' })
      setStatus(res.ok || res.type === 'opaque' ? 'ok' : 'error')
    } catch {
      setStatus('error')
    }
    setLastCheck(new Date().toLocaleTimeString())
  }, [])

  useEffect(() => { checkEtebase() }, [checkEtebase])

  const ok = status === 'ok'

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-[rgb(var(--foreground))]">Self-Hosted Admin</h1>
        <p className="mt-1 text-sm text-[rgb(var(--muted))]">Manage your self-hosted Etebase server from its Django admin panel. The liveness check only confirms the server URL responds; it is not a full health check.</p>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${ok ? 'bg-emerald-500' : status === 'checking' ? 'animate-pulse bg-[rgb(var(--muted))]' : 'bg-red-400'}`} />
            <span className={`text-xs font-medium ${ok ? 'text-emerald-500' : status === 'checking' ? 'text-[rgb(var(--muted))]' : 'text-red-400'}`}>
              {ok ? 'Server responded' : status === 'checking' ? 'Checking...' : 'Server unreachable'}
            </span>
          </div>
          <span className="inline-flex items-center gap-1 text-xs text-[rgb(var(--muted))]">
            <Activity className="h-3 w-3" /> Last check {lastCheck ?? '-'}
          </span>
        </div>
        <button
          onClick={checkEtebase}
          className="flex items-center gap-1.5 self-start rounded-md border border-[rgb(var(--border))] px-3 py-1.5 text-xs text-[rgb(var(--muted))] transition-colors hover:border-[rgb(var(--primary))] hover:text-[rgb(var(--foreground))] sm:self-auto"
        >
          <RefreshCw className={`h-3 w-3 ${status === 'checking' ? 'animate-spin' : ''}`} /> Re-check
        </button>
      </div>

      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-5">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[rgb(var(--primary))]/10">
            <Users className="h-5 w-5 text-[rgb(var(--primary))]" />
          </div>
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">User Management</p>
            <p className="text-xs text-[rgb(var(--muted))]">Handled by the Etebase admin panel for self-hosted installs</p>
          </div>
        </div>

        <p className="text-sm leading-relaxed text-[rgb(var(--foreground))]">
          Manage users, reset passwords, and inspect collections through the Etebase administration panel. The hosted SaaS billing dashboard is not part of the public self-hosted app.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <a
            href={etebaseAdminUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-[rgb(var(--primary))] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[rgb(var(--primary-hover))]"
          >
            <ExternalLink className="h-4 w-4" /> Open Etebase Admin Panel
          </a>
        </div>

        <div className="mt-4 rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] p-3">
          <p className="text-xs text-[rgb(var(--muted))]"><span className="font-medium text-[rgb(var(--foreground))]">Admin URL:</span> <span className="font-mono">{etebaseAdminUrl}</span></p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <a href={etebaseAdminUrl} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 transition-colors hover:border-[rgb(var(--primary))]">
          <div className="flex items-center gap-3"><Server className="h-5 w-5 text-[rgb(var(--primary))]" /><div><p className="text-sm font-medium text-[rgb(var(--foreground))]">Etebase Admin</p><p className="text-xs text-[rgb(var(--muted))]">Users, collections, server settings</p></div></div><ExternalLink className="h-4 w-4 text-[rgb(var(--muted))]" />
        </a>
        <a href="https://github.com/silent-suite/silentsuite" target="_blank" rel="noopener noreferrer" className="flex items-center justify-between rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 transition-colors hover:border-[rgb(var(--primary))]">
          <div className="flex items-center gap-3"><Globe className="h-5 w-5 text-[rgb(var(--primary))]" /><div><p className="text-sm font-medium text-[rgb(var(--foreground))]">Documentation</p><p className="text-xs text-[rgb(var(--muted))]">Setup guides and troubleshooting</p></div></div><ExternalLink className="h-4 w-4 text-[rgb(var(--muted))]" />
        </a>
      </div>
    </div>
  )
}
