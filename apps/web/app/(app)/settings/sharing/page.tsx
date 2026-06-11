'use client'

import { useEffect, useMemo, useState } from 'react'
import { MailPlus, RefreshCcw, ShieldCheck, Users } from 'lucide-react'
import type { CollectionAccessLevel } from '@silentsuite/core'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'

type SharingCollectionType = 'calendar' | 'tasks' | 'contacts'

type CollectionCard = {
  type: SharingCollectionType
  uid: string
  name: string
  accessLevel?: number
}

type MembersByCollection = Record<string, Array<{ username: string; accessLevel: number }>>

const COLLECTION_LABELS: Record<SharingCollectionType, string> = {
  calendar: 'Calendar',
  tasks: 'Task list',
  contacts: 'Address book',
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

function invitationTitle(invitation: any): string {
  return invitation?.fromUsername || invitation?.username || 'Unknown sender'
}

export default function SharingSettingsPage() {
  const account = useEtebaseStore((state) => state.account)
  const collections = useEtebaseStore((state) => state.collections)
  const listIncomingInvitations = useEtebaseStore((state) => state.listIncomingInvitations)
  const acceptInvitation = useEtebaseStore((state) => state.acceptInvitation)
  const rejectInvitation = useEtebaseStore((state) => state.rejectInvitation)
  const inviteToCollection = useEtebaseStore((state) => state.inviteToCollection)
  const listCollectionMembers = useEtebaseStore((state) => state.listCollectionMembers)
  const leaveCollection = useEtebaseStore((state) => state.leaveCollection)

  const [invitations, setInvitations] = useState<any[]>([])
  const [members, setMembers] = useState<MembersByCollection>({})
  const [inviteUsernames, setInviteUsernames] = useState<Record<string, string>>({})
  const [inviteAccessLevels, setInviteAccessLevels] = useState<Record<string, CollectionAccessLevel>>({})
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const collectionCards = useMemo<CollectionCard[]>(() => {
    const cards: CollectionCard[] = []
    for (const type of ['calendar', 'tasks', 'contacts'] as const) {
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

  async function refreshInvitations() {
    setLoading(true)
    try {
      setInvitations(await listIncomingInvitations())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!account) return
    void refreshInvitations()
    // listIncomingInvitations is stable enough through Zustand for this client-only page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account])

  async function handleAccept(invitation: any) {
    setMessage(null)
    const ok = await acceptInvitation(invitation)
    if (ok) {
      setMessage('Invitation accepted. Shared collections are refreshing now.')
      await refreshInvitations()
    }
  }

  async function handleReject(invitation: any) {
    setMessage(null)
    const ok = await rejectInvitation(invitation)
    if (ok) {
      setMessage('Invitation rejected.')
      await refreshInvitations()
    }
  }

  async function handleLoadMembers(card: CollectionCard) {
    const loaded = await listCollectionMembers(card.type, card.uid)
    setMembers((current) => ({ ...current, [card.uid]: loaded }))
  }

  async function handleInvite(card: CollectionCard) {
    const username = inviteUsernames[card.uid]?.trim()
    if (!username) {
      setMessage('Enter the account username or email to invite.')
      return
    }
    const accessLevel = inviteAccessLevels[card.uid] ?? 'readOnly'
    const ok = await inviteToCollection(card.type, card.uid, username, accessLevel)
    if (ok) {
      setInviteUsernames((current) => ({ ...current, [card.uid]: '' }))
      setMessage(`Invitation sent to ${username}.`)
      await handleLoadMembers(card)
    }
  }

  async function handleLeave(card: CollectionCard) {
    const ok = window.confirm(`Leave shared ${card.name}? This removes it from this account.`)
    if (!ok) return
    const left = await leaveCollection(card.type, card.uid)
    if (left) {
      setMessage(`Left ${card.name}.`)
    }
  }

  if (!account) {
    return (
      <div className="space-y-3">
        <h2 className="text-base font-semibold text-[rgb(var(--foreground))]">Sharing</h2>
        <p className="text-sm text-[rgb(var(--muted))]">Sign in before managing shared calendars, task lists, or address books.</p>
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
              <p className="text-sm font-medium text-[rgb(var(--foreground))]">Incoming invitations</p>
              <p className="text-xs text-[rgb(var(--muted))]">Accepting an invite refreshes your collections so the share appears in web and DAV clients.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={refreshInvitations}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-[rgb(var(--border))] px-3 py-2 text-xs font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--background))] disabled:opacity-50"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>

        {invitations.length === 0 ? (
          <p className="text-sm text-[rgb(var(--muted))]">No pending invitations.</p>
        ) : (
          <div className="space-y-2">
            {invitations.map((invitation) => (
              <div key={invitation.uid} className="flex flex-col gap-3 rounded-lg border border-[rgb(var(--border))] p-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-[rgb(var(--foreground))]">Invitation from {invitationTitle(invitation)}</p>
                  <p className="text-xs text-[rgb(var(--muted))]">Access: {accessLevelLabel(invitation.accessLevel)}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => handleReject(invitation)} className="rounded-lg border border-[rgb(var(--border))] px-3 py-2 text-xs font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--background))]">
                    Reject
                  </button>
                  <button type="button" onClick={() => handleAccept(invitation)} className="rounded-lg bg-[rgb(var(--primary))] px-3 py-2 text-xs font-medium text-white hover:bg-[rgb(var(--primary-hover))]">
                    Accept
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 space-y-4">
        <div className="flex items-start gap-3">
          <Users className="h-5 w-5 text-[rgb(var(--primary))] mt-0.5" />
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Collection members</p>
            <p className="text-xs text-[rgb(var(--muted))]">Invite trusted accounts by username/email. Plain calendar, contact, and task data still stays end-to-end encrypted.</p>
          </div>
        </div>

        <div className="grid gap-3">
          {collectionCards.map((card) => (
            <div key={card.uid} className="rounded-lg border border-[rgb(var(--border))] p-3 space-y-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-[rgb(var(--foreground))]">{card.name}</p>
                  <p className="text-xs text-[rgb(var(--muted))]">{COLLECTION_LABELS[card.type]} · {accessLevelLabel(card.accessLevel)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => handleLoadMembers(card)} className="rounded-lg border border-[rgb(var(--border))] px-3 py-2 text-xs font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--background))]">
                    Load members
                  </button>
                  {card.accessLevel !== 1 && (
                    <button type="button" onClick={() => handleLeave(card)} className="rounded-lg border border-[rgb(var(--border))] px-3 py-2 text-xs font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--background))]">
                      Leave
                    </button>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  value={inviteUsernames[card.uid] ?? ''}
                  onChange={(event) => setInviteUsernames((current) => ({ ...current, [card.uid]: event.target.value }))}
                  placeholder="friend@example.com"
                  className="min-w-0 flex-1 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-3 py-2 text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))]"
                />
                <select
                  value={inviteAccessLevels[card.uid] ?? 'readOnly'}
                  onChange={(event) => setInviteAccessLevels((current) => ({ ...current, [card.uid]: event.target.value as CollectionAccessLevel }))}
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

              {members[card.uid] && (
                <ul className="space-y-1 text-xs text-[rgb(var(--muted))]">
                  {members[card.uid].map((member) => (
                    <li key={member.username} className="flex justify-between gap-3 rounded border border-[rgb(var(--border))] px-2 py-1">
                      <span>{member.username}</span>
                      <span>{accessLevelLabel(member.accessLevel)}</span>
                    </li>
                  ))}
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
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Zero-knowledge sharing</p>
            <p className="text-xs text-[rgb(var(--muted))]">
              Sharing uses Etebase encrypted collection membership. The server only sees encrypted membership material; plaintext events, contacts, and tasks stay on your devices.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
