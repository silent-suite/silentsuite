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

type Member = { username: string; accessLevel: number }
type MembersByCollection = Record<string, Member[]>
type AccessDrafts = Record<string, CollectionAccessLevel>

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

function accessLevelValue(accessLevel?: number): CollectionAccessLevel {
  if (accessLevel === 1) return 'admin'
  if (accessLevel === 2) return 'readWrite'
  return 'readOnly'
}

function invitationTitle(invitation: any): string {
  return invitation?.fromUsername || invitation?.username || 'Unknown sender'
}

function outgoingInvitationTitle(invitation: any): string {
  return invitation?.username || invitation?.toUsername || 'Unknown recipient'
}

export default function SharingSettingsPage() {
  const account = useEtebaseStore((state) => state.account)
  const collections = useEtebaseStore((state) => state.collections)
  const listIncomingInvitations = useEtebaseStore((state) => state.listIncomingInvitations)
  const listOutgoingInvitations = useEtebaseStore((state) => state.listOutgoingInvitations)
  const acceptInvitation = useEtebaseStore((state) => state.acceptInvitation)
  const rejectInvitation = useEtebaseStore((state) => state.rejectInvitation)
  const cancelOutgoingInvitation = useEtebaseStore((state) => state.cancelOutgoingInvitation)
  const inviteToCollection = useEtebaseStore((state) => state.inviteToCollection)
  const listCollectionMembers = useEtebaseStore((state) => state.listCollectionMembers)
  const removeCollectionMember = useEtebaseStore((state) => state.removeCollectionMember)
  const modifyCollectionMemberAccess = useEtebaseStore((state) => state.modifyCollectionMemberAccess)
  const leaveCollection = useEtebaseStore((state) => state.leaveCollection)

  const [incomingInvitations, setIncomingInvitations] = useState<any[]>([])
  const [outgoingInvitations, setOutgoingInvitations] = useState<any[]>([])
  const [members, setMembers] = useState<MembersByCollection>({})
  const [inviteUsernames, setInviteUsernames] = useState<Record<string, string>>({})
  const [inviteAccessLevels, setInviteAccessLevels] = useState<Record<string, CollectionAccessLevel>>({})
  const [memberAccessDrafts, setMemberAccessDrafts] = useState<AccessDrafts>({})
  const [loadingInvites, setLoadingInvites] = useState(false)
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
    setLoadingInvites(true)
    try {
      const [incoming, outgoing] = await Promise.all([
        listIncomingInvitations(),
        listOutgoingInvitations(),
      ])
      setIncomingInvitations(incoming)
      setOutgoingInvitations(outgoing)
    } finally {
      setLoadingInvites(false)
    }
  }

  useEffect(() => {
    if (!account) return
    void refreshInvitations()
    // Store functions are stable enough for this client-only settings panel.
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

  async function handleCancelOutgoing(invitation: any) {
    setMessage(null)
    const ok = await cancelOutgoingInvitation(invitation)
    if (ok) {
      setMessage('Outgoing invitation cancelled.')
      await refreshInvitations()
    }
  }

  async function handleLoadMembers(card: CollectionCard) {
    const loaded = await listCollectionMembers(card.type, card.uid)
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
      await refreshInvitations()
      await handleLoadMembers(card)
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
          Sign in before managing shared calendars, task lists, or address books.
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
            ) : incomingInvitations.map((invitation) => (
              <div key={invitation.uid} className="rounded-lg border border-[rgb(var(--border))] p-3 space-y-3">
                <div>
                  <p className="text-sm font-medium text-[rgb(var(--foreground))]">From {invitationTitle(invitation)}</p>
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
              Invite trusted accounts by username/email. Plain calendar, contact, and task data remains encrypted.
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
                  <button type="button" onClick={() => handleLoadMembers(card)} className="rounded-lg border border-[rgb(var(--border))] px-3 py-2 text-xs font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--background))]">
                    Load members
                  </button>
                  {card.accessLevel !== 1 && (
                    <button type="button" onClick={() => handleLeave(card)} className="rounded-lg border border-[rgb(var(--border))] px-3 py-2 text-xs font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--background))]">
                      Leave collection
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
                <ul className="space-y-2 text-xs text-[rgb(var(--muted))]">
                  {members[card.uid].map((member) => {
                    const draftKey = `${card.uid}:${member.username}`
                    return (
                      <li key={member.username} className="flex flex-col gap-2 rounded border border-[rgb(var(--border))] px-2 py-2 sm:flex-row sm:items-center sm:justify-between">
                        <span className="font-medium text-[rgb(var(--foreground))]">{member.username}</span>
                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            value={memberAccessDrafts[draftKey] ?? accessLevelValue(member.accessLevel)}
                            onChange={(event) => setMemberAccessDrafts((current) => ({
                              ...current,
                              [draftKey]: event.target.value as CollectionAccessLevel,
                            }))}
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
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Zero-knowledge sharing</p>
            <p className="text-xs text-[rgb(var(--muted))]">
              Sharing uses Etebase encrypted collection membership. The server only sees encrypted membership material;
              plaintext events, contacts, and tasks stay on your devices.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
