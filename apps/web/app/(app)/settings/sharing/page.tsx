'use client'

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { MailPlus, RefreshCcw, ShieldCheck, Users } from 'lucide-react'
import type { CollectionAccessLevel } from '@silentsuite/core'
import {
  useEtebaseStore,
  type IncomingInvitationView,
  type PendingCollectionInvite,
} from '@/app/stores/use-etebase-store'

type SharingCollectionType = 'calendar' | 'tasks' | 'contacts' | 'notes'

type CollectionCard = {
  type: SharingCollectionType
  uid: string
  name: string
  accessLevel?: number
}

type Member = { username: string; accessLevel: number }
type MembersByCollection = Record<string, Member[]>
type AccessDrafts = Record<string, CollectionAccessLevel>

type PendingInviteState = {
  pending: PendingCollectionInvite
  card: CollectionCard
  collection: unknown
}

const COLLECTION_LABELS: Record<SharingCollectionType, string> = {
  calendar: 'Calendar',
  tasks: 'Task list',
  contacts: 'Address book',
  notes: 'Notebook',
}

const ACCESS_LEVEL_LABELS: Record<CollectionAccessLevel, string> = {
  admin: 'Admin',
  readWrite: 'Read/write',
  readOnly: 'Read-only',
}

function collectionName(collection: any, fallback: string): string {
  try {
    return collection?.getMeta?.()?.name || collection?.meta?.name || fallback
  } catch {
    return fallback
  }
}

function accessLevelLabel(accessLevel?: number): string {
  if (accessLevel === 1) return 'Admin'
  if (accessLevel === 0) return 'Read-only'
  if (accessLevel === 2) return 'Read/write'
  return 'Unknown access'
}

function accessLevelValue(accessLevel?: number): CollectionAccessLevel {
  if (accessLevel === 1) return 'admin'
  if (accessLevel === 2) return 'readWrite'
  return 'readOnly'
}

// The sender name comes from the server; never fall back to the recipient's own username.
function invitationTitle(invitation: IncomingInvitationView): string {
  return invitation.senderName ?? 'Unknown sender'
}

function outgoingInvitationTitle(invitation: any): string {
  return invitation?.username || invitation?.toUsername || 'Unknown recipient'
}

function FingerprintConfirmDialog({
  title,
  fingerprint,
  confirmLabel,
  submitting,
  onConfirm,
  onCancel,
  children,
}: {
  title: string
  fingerprint: string
  confirmLabel: string
  submitting: boolean
  onConfirm: () => void
  onCancel: () => void
  children: ReactNode
}) {
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelRef.current?.focus()
    return () => {
      previouslyFocused?.focus()
    }
  }, [])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!submitting) onCancel()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]') ?? [])
    if (focusable.length === 0) {
      event.preventDefault()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      data-testid="sharing-dialog-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={handleKeyDown}
        className="w-full max-w-md rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] p-6 shadow-xl space-y-4"
      >
        <h3 id={titleId} className="text-sm font-semibold text-[rgb(var(--foreground))]">{title}</h3>
        <div id={descriptionId} className="space-y-2 text-xs text-[rgb(var(--muted))]">
          {children}
        </div>
        <code className="block break-all rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-3 font-mono text-xs text-[rgb(var(--foreground))]">
          {fingerprint}
        </code>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-lg border border-[rgb(var(--border))] px-3 py-2 text-xs font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className="rounded-lg bg-[rgb(var(--primary))] px-3 py-2 text-xs font-medium text-white hover:bg-[rgb(var(--primary-hover))] disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function SharingSettingsPage() {
  const account = useEtebaseStore((state) => state.account)
  const accountFingerprint = useEtebaseStore((state) => state.accountFingerprint)
  const collections = useEtebaseStore((state) => state.collections)
  const listIncomingInvitations = useEtebaseStore((state) => state.listIncomingInvitations)
  const listOutgoingInvitations = useEtebaseStore((state) => state.listOutgoingInvitations)
  const acceptInvitation = useEtebaseStore((state) => state.acceptInvitation)
  const rejectInvitation = useEtebaseStore((state) => state.rejectInvitation)
  const cancelOutgoingInvitation = useEtebaseStore((state) => state.cancelOutgoingInvitation)
  const prepareCollectionInvite = useEtebaseStore((state) => state.prepareCollectionInvite)
  const confirmCollectionInvite = useEtebaseStore((state) => state.confirmCollectionInvite)
  const discardCollectionInvite = useEtebaseStore((state) => state.discardCollectionInvite)
  const listCollectionMembers = useEtebaseStore((state) => state.listCollectionMembers)
  const removeCollectionMember = useEtebaseStore((state) => state.removeCollectionMember)
  const modifyCollectionMemberAccess = useEtebaseStore((state) => state.modifyCollectionMemberAccess)
  const leaveCollection = useEtebaseStore((state) => state.leaveCollection)

  const [incomingInvitations, setIncomingInvitations] = useState<IncomingInvitationView[]>([])
  const [outgoingInvitations, setOutgoingInvitations] = useState<any[]>([])
  const [members, setMembers] = useState<MembersByCollection>({})
  const [inviteUsernames, setInviteUsernames] = useState<Record<string, string>>({})
  const [inviteAccessLevels, setInviteAccessLevels] = useState<Record<string, CollectionAccessLevel>>({})
  const [memberAccessDrafts, setMemberAccessDrafts] = useState<AccessDrafts>({})
  const [loadingInvites, setLoadingInvites] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [pendingInvite, setPendingInvite] = useState<PendingInviteState | null>(null)
  const [pendingAccept, setPendingAccept] = useState<IncomingInvitationView | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // Bumped on account/server change and unmount so stale async results never publish.
  const requestGeneration = useRef(0)
  const pendingInviteRef = useRef<PendingInviteState | null>(null)
  const prepareInFlight = useRef(false)
  const submitInFlight = useRef(false)
  const currentUsername = (account as any)?.user?.username ?? (account as any)?.username ?? null

  const collectionCards = useMemo<CollectionCard[]>(() => {
    const cards: CollectionCard[] = []
    for (const type of ['calendar', 'tasks', 'contacts', 'notes'] as const) {
      collections[type].forEach((collection, index) => {
        cards.push({
          type,
          uid: collection.uid,
          name: collectionName(collection, index === 0 ? COLLECTION_LABELS[type] : `${COLLECTION_LABELS[type]} ${index + 1}`),
          accessLevel: collection.accessLevel,
        })
      })
    }
    return cards
  }, [collections])

  function dismissPendingInvite() {
    const current = pendingInviteRef.current
    if (current) discardCollectionInvite(current.pending)
    pendingInviteRef.current = null
    setPendingInvite(null)
  }

  async function refreshInvitations() {
    const generation = requestGeneration.current
    setLoadingInvites(true)
    try {
      const [incoming, outgoing] = await Promise.all([
        listIncomingInvitations(),
        listOutgoingInvitations(),
      ])
      if (generation !== requestGeneration.current) return
      setIncomingInvitations(incoming)
      setOutgoingInvitations(outgoing)
    } finally {
      setLoadingInvites(false)
    }
  }

  useEffect(() => {
    requestGeneration.current += 1
    dismissPendingInvite()
    setPendingAccept(null)
    setIncomingInvitations([])
    setOutgoingInvitations([])
    setMembers({})
    setMessage(null)
    if (!account) return
    void refreshInvitations()
    // Store functions are stable enough for this client-only settings panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, accountFingerprint])

  useEffect(() => {
    const generationRef = requestGeneration
    const pendingRef = pendingInviteRef
    return () => {
      generationRef.current += 1
      if (pendingRef.current) discardCollectionInvite(pendingRef.current.pending)
      pendingRef.current = null
    }
  }, [discardCollectionInvite])

  // A pending invite is only valid for the exact collection object and form values it was fetched for.
  useEffect(() => {
    if (!pendingInvite) return
    const { pending, collection } = pendingInvite
    const currentCollection = collections[pending.type]?.find((candidate) => candidate.uid === pending.collectionUid)
    const stillCurrent = currentCollection === collection
      && (inviteUsernames[pending.collectionUid] ?? '').trim() === pending.username
      && (inviteAccessLevels[pending.collectionUid] ?? 'readOnly') === pending.accessLevel
    if (!stillCurrent) dismissPendingInvite()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collections, inviteUsernames, inviteAccessLevels, pendingInvite])

  async function handleReject(invitation: IncomingInvitationView) {
    const generation = requestGeneration.current
    setMessage(null)
    const ok = await rejectInvitation(invitation)
    if (generation !== requestGeneration.current) return
    if (ok) {
      setMessage('Invitation rejected.')
      await refreshInvitations()
    }
  }

  async function handleCancelOutgoing(invitation: any) {
    const generation = requestGeneration.current
    setMessage(null)
    const ok = await cancelOutgoingInvitation(invitation)
    if (generation !== requestGeneration.current) return
    if (ok) {
      setMessage('Outgoing invitation cancelled.')
      await refreshInvitations()
    }
  }

  async function handleLoadMembers(card: CollectionCard) {
    const generation = requestGeneration.current
    const loaded = await listCollectionMembers(card.type, card.uid)
    if (generation !== requestGeneration.current) return
    setMembers((current) => ({ ...current, [card.uid]: loaded }))
    setMemberAccessDrafts((current) => {
      const next = { ...current }
      loaded.forEach((member) => {
        next[`${card.uid}:${member.username}`] = accessLevelValue(member.accessLevel)
      })
      return next
    })
  }

  async function handleInvite(card: CollectionCard) {
    if (prepareInFlight.current || pendingInviteRef.current) return
    const username = inviteUsernames[card.uid]?.trim()
    if (!username) {
      setMessage('Enter the account username or email to invite.')
      return
    }
    const accessLevel = inviteAccessLevels[card.uid] ?? 'readOnly'
    const collection = collections[card.type].find((candidate) => candidate.uid === card.uid)
    const generation = requestGeneration.current
    setMessage(null)
    prepareInFlight.current = true
    try {
      const pending = await prepareCollectionInvite(card.type, card.uid, username, accessLevel)
      if (!pending) return
      if (generation !== requestGeneration.current) {
        discardCollectionInvite(pending)
        return
      }
      const next: PendingInviteState = { pending, card, collection }
      pendingInviteRef.current = next
      setPendingInvite(next)
    } finally {
      prepareInFlight.current = false
    }
  }

  async function handleConfirmInvite() {
    const current = pendingInviteRef.current
    if (!current || submitInFlight.current) return
    submitInFlight.current = true
    setSubmitting(true)
    const generation = requestGeneration.current
    try {
      const ok = await confirmCollectionInvite(current.pending)
      if (generation !== requestGeneration.current) return
      pendingInviteRef.current = null
      setPendingInvite(null)
      if (!ok) {
        setMessage('The invitation was not sent. Invite again to fetch and compare a fresh fingerprint.')
        return
      }
      setInviteUsernames((values) => ({ ...values, [current.card.uid]: '' }))
      setMessage(`Invitation sent to ${current.pending.username}.`)
      await refreshInvitations()
      if (generation !== requestGeneration.current) return
      await handleLoadMembers(current.card)
    } finally {
      submitInFlight.current = false
      setSubmitting(false)
    }
  }

  function handleAccept(invitation: IncomingInvitationView) {
    if (!invitation.senderFingerprint) return
    setMessage(null)
    setPendingAccept(invitation)
  }

  async function handleConfirmAccept() {
    const invitation = pendingAccept
    if (!invitation?.senderFingerprint || submitInFlight.current) return
    submitInFlight.current = true
    setSubmitting(true)
    const generation = requestGeneration.current
    try {
      const ok = await acceptInvitation(invitation, invitation.senderFingerprint)
      if (generation !== requestGeneration.current) return
      setPendingAccept(null)
      if (!ok) {
        setMessage('The invitation was not accepted. Refresh and compare the fingerprint again before retrying.')
        return
      }
      setMessage('Invitation accepted. Shared collections are refreshing now.')
      await refreshInvitations()
    } finally {
      submitInFlight.current = false
      setSubmitting(false)
    }
  }

  async function handleRemoveMember(card: CollectionCard, username: string) {
    const ok = window.confirm(`Remove ${username} from ${card.name}?`)
    if (!ok) return
    const removed = await removeCollectionMember(card.type, card.uid, username)
    if (removed) {
      setMessage(`${username} was removed from ${card.name}.`)
      await handleLoadMembers(card)
    }
  }

  async function handleChangeMemberAccess(card: CollectionCard, member: Member) {
    const key = `${card.uid}:${member.username}`
    const nextAccess = memberAccessDrafts[key] ?? accessLevelValue(member.accessLevel)
    const changed = await modifyCollectionMemberAccess(card.type, card.uid, member.username, nextAccess)
    if (changed) {
      setMessage(`${member.username} is now ${ACCESS_LEVEL_LABELS[nextAccess].toLowerCase()} on ${card.name}.`)
      await handleLoadMembers(card)
    }
  }

  async function handleLeave(card: CollectionCard) {
    const ok = window.confirm(`Leave shared ${card.name}? This removes it from this account.`)
    if (!ok) return
    const left = await leaveCollection(card.type, card.uid)
    if (left) setMessage(`Left ${card.name}.`)
  }

  if (!account) {
    return (
      <div className="space-y-3">
        <h2 className="text-base font-semibold text-[rgb(var(--foreground))]">Sharing</h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          Sign in before managing shared calendars, task lists, address books, or notebooks.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-base font-semibold text-[rgb(var(--foreground))]">Sharing</h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          Accept encrypted Etebase sharing invitations and invite other SilentSuite accounts to your collections.
        </p>
        <p className="text-xs text-[rgb(var(--muted))]">
          Before sending or accepting an invitation, compare security fingerprints with the other person over a separate
          channel. Your own fingerprint is under{' '}
          <Link href="/settings/security" className="underline text-[rgb(var(--primary))]">Settings → Security</Link>.
        </p>
      </div>

      {message && (
        <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-3 text-sm text-[rgb(var(--foreground))]">
          {message}
        </div>
      )}

      <section className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <MailPlus className="h-5 w-5 text-[rgb(var(--primary))]" />
            <div>
              <p className="text-sm font-medium text-[rgb(var(--foreground))]">Invitations</p>
              <p className="text-xs text-[rgb(var(--muted))]">
                Accepting an invite refreshes collections so the share appears in web and DAV clients.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={refreshInvitations}
            disabled={loadingInvites}
            className="inline-flex items-center gap-2 rounded-lg border border-[rgb(var(--border))] px-3 py-2 text-xs font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--background))] disabled:opacity-50"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-[rgb(var(--muted))]">Incoming</p>
            {incomingInvitations.length === 0 ? (
              <p className="text-sm text-[rgb(var(--muted))]">No pending incoming invitations.</p>
            ) : incomingInvitations.map((invitation, index) => (
              <div key={invitation.uid || `invalid-${index}`} className="rounded-lg border border-[rgb(var(--border))] p-3 space-y-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-[rgb(var(--foreground))]">From {invitationTitle(invitation)}</p>
                  <p className="text-xs text-[rgb(var(--muted))]">Access: {accessLevelLabel(invitation.accessLevel)}</p>
                  {invitation.senderFingerprint ? (
                    <code className="block break-all font-mono text-xs text-[rgb(var(--foreground))]">{invitation.senderFingerprint}</code>
                  ) : (
                    <p className="text-xs text-red-400">Sender key unavailable</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => handleReject(invitation)} className="rounded-lg border border-[rgb(var(--border))] px-3 py-2 text-xs font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--background))]">
                    Reject
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAccept(invitation)}
                    disabled={!invitation.senderFingerprint}
                    className="rounded-lg bg-[rgb(var(--primary))] px-3 py-2 text-xs font-medium text-white hover:bg-[rgb(var(--primary-hover))] disabled:opacity-50"
                  >
                    Accept
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-[rgb(var(--muted))]">Sent</p>
            {outgoingInvitations.length === 0 ? (
              <p className="text-sm text-[rgb(var(--muted))]">No pending sent invitations.</p>
            ) : outgoingInvitations.map((invitation) => (
              <div key={invitation.uid} className="rounded-lg border border-[rgb(var(--border))] p-3 space-y-3">
                <div>
                  <p className="text-sm font-medium text-[rgb(var(--foreground))]">To {outgoingInvitationTitle(invitation)}</p>
                  <p className="text-xs text-[rgb(var(--muted))]">Access: {accessLevelLabel(invitation.accessLevel)}</p>
                </div>
                <button type="button" onClick={() => handleCancelOutgoing(invitation)} className="rounded-lg border border-[rgb(var(--border))] px-3 py-2 text-xs font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--background))]">
                  Cancel invitation
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 space-y-4">
        <div className="flex items-start gap-3">
          <Users className="h-5 w-5 text-[rgb(var(--primary))] mt-0.5" />
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Collection members</p>
            <p className="text-xs text-[rgb(var(--muted))]">
              Invite accounts by username or email. Shared data is end-to-end encrypted to the keys you confirm.
            </p>
          </div>
        </div>

        <div className="grid gap-3">
          {collectionCards.map((card) => (
            <div key={card.uid} className="rounded-lg border border-[rgb(var(--border))] p-3 space-y-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-[rgb(var(--foreground))]">{card.name}</p>
                  <p className="text-xs text-[rgb(var(--muted))]">
                    {COLLECTION_LABELS[card.type]} · {accessLevelLabel(card.accessLevel)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {card.accessLevel === 1 && (
                    <button type="button" onClick={() => handleLoadMembers(card)} className="rounded-lg border border-[rgb(var(--border))] px-3 py-2 text-xs font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--background))]">
                      Load members
                    </button>
                  )}
                  {card.accessLevel !== 1 && (
                    <button type="button" onClick={() => handleLeave(card)} className="rounded-lg border border-[rgb(var(--border))] px-3 py-2 text-xs font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--background))]">
                      Leave collection
                    </button>
                  )}
                </div>
              </div>

              {card.accessLevel === 1 ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    value={inviteUsernames[card.uid] ?? ''}
                    onChange={(event) => {
                      // Read the value now; the updater can run after React has restored the controlled DOM value.
                      const value = event.target.value
                      setInviteUsernames((current) => ({ ...current, [card.uid]: value }))
                    }}
                    placeholder="friend@example.com"
                    className="min-w-0 flex-1 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-3 py-2 text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))]"
                  />
                  <select
                    value={inviteAccessLevels[card.uid] ?? 'readOnly'}
                    onChange={(event) => {
                      const value = event.target.value as CollectionAccessLevel
                      setInviteAccessLevels((current) => ({ ...current, [card.uid]: value }))
                    }}
                    className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-3 py-2 text-sm text-[rgb(var(--foreground))]"
                  >
                    {Object.entries(ACCESS_LEVEL_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                  <button type="button" onClick={() => handleInvite(card)} className="rounded-lg bg-[rgb(var(--primary))] px-3 py-2 text-xs font-medium text-white hover:bg-[rgb(var(--primary-hover))]">
                    Invite
                  </button>
                </div>
              ) : (
                <p className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-3 py-2 text-xs text-[rgb(var(--muted))]">
                  Shared with {accessLevelLabel(card.accessLevel).toLowerCase()} access. Only admins can invite accounts or manage members.
                </p>
              )}

              {members[card.uid] && (
                <ul className="space-y-2 text-xs text-[rgb(var(--muted))]">
                  {members[card.uid].map((member) => {
                    const draftKey = `${card.uid}:${member.username}`
                    const isCurrentUser = currentUsername === member.username
                    return (
                      <li key={member.username} className="flex flex-col gap-2 rounded border border-[rgb(var(--border))] px-2 py-2 sm:flex-row sm:items-center sm:justify-between">
                        <span className="font-medium text-[rgb(var(--foreground))]">
                          {member.username}{isCurrentUser ? ' (you)' : ''}
                        </span>
                        {isCurrentUser ? (
                          <span className="text-xs text-[rgb(var(--muted))]">
                            {accessLevelLabel(member.accessLevel)} · Manage your own access from another admin account.
                          </span>
                        ) : (
                          <div className="flex flex-wrap items-center gap-2">
                            <select
                              value={memberAccessDrafts[draftKey] ?? accessLevelValue(member.accessLevel)}
                              onChange={(event) => {
                                const value = event.target.value as CollectionAccessLevel
                                setMemberAccessDrafts((current) => ({ ...current, [draftKey]: value }))
                              }}
                              className="rounded border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-2 py-1 text-xs text-[rgb(var(--foreground))]"
                            >
                              {Object.entries(ACCESS_LEVEL_LABELS).map(([value, label]) => (
                                <option key={value} value={value}>{label}</option>
                              ))}
                            </select>
                            <button type="button" onClick={() => handleChangeMemberAccess(card, member)} className="rounded border border-[rgb(var(--border))] px-2 py-1 text-xs text-[rgb(var(--foreground))] hover:bg-[rgb(var(--background))]">
                              Save
                            </button>
                            <button type="button" onClick={() => handleRemoveMember(card, member.username)} className="rounded border border-[rgb(var(--border))] px-2 py-1 text-xs text-[rgb(var(--foreground))] hover:bg-[rgb(var(--background))]">
                              Remove
                            </button>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>

      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="h-5 w-5 text-[rgb(var(--primary))] mt-0.5 flex-shrink-0" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">End-to-end encrypted sharing</p>
            <p className="text-xs text-[rgb(var(--muted))]">
              Shared calendars, contacts, tasks, and notes are encrypted to the public keys you confirm. That protection
              depends on comparing security fingerprints with the other person over a separate channel; the server
              supplies usernames and keys and cannot vouch for them. Removing a member does not revoke a key they
              already received.
            </p>
          </div>
        </div>
      </div>

      {pendingInvite && (
        <FingerprintConfirmDialog
          title="Verify security fingerprint"
          fingerprint={pendingInvite.pending.fingerprint}
          confirmLabel="Fingerprint matches, send invitation"
          submitting={submitting}
          onConfirm={handleConfirmInvite}
          onCancel={dismissPendingInvite}
        >
          <p>
            Sharing {pendingInvite.card.name} ({COLLECTION_LABELS[pendingInvite.card.type]}) with {pendingInvite.pending.username} as{' '}
            {ACCESS_LEVEL_LABELS[pendingInvite.pending.accessLevel]}.
          </p>
          <p>
            Ask {pendingInvite.pending.username} to open Settings → Security → Account fingerprint and read it to you over a
            channel other than SilentSuite, such as in person or on a call. Continue only if every character matches.
          </p>
          <p>
            The username is supplied by the server and is not verified. Confirming without comparing gives no assurance
            that the right person receives access.
          </p>
        </FingerprintConfirmDialog>
      )}

      {pendingAccept?.senderFingerprint && (
        <FingerprintConfirmDialog
          title="Verify sender fingerprint"
          fingerprint={pendingAccept.senderFingerprint}
          confirmLabel="Fingerprint matches, accept"
          submitting={submitting}
          onConfirm={handleConfirmAccept}
          onCancel={() => setPendingAccept(null)}
        >
          <p>
            From {invitationTitle(pendingAccept)} · {accessLevelLabel(pendingAccept.accessLevel)} access.
          </p>
          <p>
            The sender name is supplied by the server and is not verified. Ask the sender to open Settings → Security →
            Account fingerprint and read it to you over a channel other than SilentSuite, such as in person or on a call.
            Accept only if every character matches.
          </p>
        </FingerprintConfirmDialog>
      )}
    </div>
  )
}
