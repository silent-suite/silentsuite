'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { parseVCard, splitVCardFile } from '@silentsuite/core/utils/vcard-parser'
import type { VCard } from '@silentsuite/core/utils/vcard-parser'
import FileDropZone from './FileDropZone'
import ImportPreview from './ImportPreview'
import ImportListSelector from './ImportListSelector'
import GoogleImportButton from './GoogleImportButton'
import MicrosoftImportButton from './MicrosoftImportButton'
import { importSourceKeys } from '@/app/lib/google-import/source-key'
import { RECONCILE_FAILED_MESSAGE, serverImportSourceKeys } from '@/app/lib/google-import/reconcile'
import { useContactStore } from '@/app/stores/use-contact-store'
import { useContactListStore } from '@/app/stores/use-contact-list-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'
import { normalizeLabels } from '@/app/components/LabelEditor'
import type { ImportIncompleteError, ImportPositionOutcome } from '@/app/lib/import-outcome'

// Large address books with long notes can exceed 10 MB; each batch still uploads separately.
export const MAX_CONTACT_IMPORT_FILE_BYTES = 50 * 1024 * 1024

// Android stores a contact in one provider batch; a note far past this (an estimate) can stop its sync.
export const LONG_CONTACT_NOTE_CHARS = 200_000

const sourceKeyOf = (contact: VCard) => (contact as VCard & { sourceKey?: string }).sourceKey

function hasProviderContacts(contacts: VCard[]): boolean {
  return contacts.some((contact) => sourceKeyOf(contact) !== undefined)
}

/**
 * Contacts read from a provider whose source is in `existing` are left out, so a re-import never
 * adds one twice. File contacts pass through unchanged. People are never matched by name,
 * phone or email.
 */
function withoutImported(contacts: VCard[], existing: ReadonlySet<string>): { contacts: VCard[]; skipped: number } {
  const keyOf = sourceKeyOf
  if (!hasProviderContacts(contacts)) return { contacts, skipped: 0 }
  const kept = contacts.filter((contact) => {
    const key = keyOf(contact)
    return key === undefined || !existing.has(key)
  })
  return { contacts: kept, skipped: contacts.length - kept.length }
}

function isImportIncomplete(err: unknown): err is ImportIncompleteError {
  return err instanceof Error && err.name === 'ImportIncompleteError'
}

function isReconcileFailed(err: unknown): boolean {
  return err instanceof Error && err.name === 'ImportReconcileFailedError'
}

function isAlreadyRunning(err: unknown): boolean {
  return err instanceof Error && err.name === 'ImportAlreadyRunningError'
}

/** File imports: built from the existing sentences, per position outcome; skipped cards are not counted. */
function fileIncompleteMessage(outcomes: readonly ImportPositionOutcome[]): string {
  const saved = outcomes.filter((outcome) => outcome === 'saved').length
  const unsaved = outcomes.filter((outcome) => outcome === 'notSent' || outcome === 'refused').length
  const unconfirmed = outcomes.filter((outcome) => outcome === 'uncertain').length
  const total = saved + unsaved + unconfirmed
  if (saved === 0 && unconfirmed === 0) return `None of the ${total} contacts were saved. They're listed below so you can import them again.`
  const parts = [`Imported ${saved} of ${total} contacts.`]
  if (unsaved > 0) parts.push(`${unsaved} weren't saved and are listed below so you can import them again.`)
  if (unconfirmed > 0) parts.push(`${unconfirmed} weren't confirmed as saved and are listed below. If the connection dropped, some may already be saved, so check your list before importing them again.`)
  return parts.join(' ')
}

const UNSAFE_UID = /[\u0000-\u001f\u007f]/

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Gives every card of the selection a UID that is unique within it. The first card with an
 * explicit (nonempty, control-free) UID keeps it; a missing or unsafe UID, or a repeat, gets
 * `import-<sha256 of the card text>-<n>` with the smallest n no explicit or assigned UID uses,
 * so the same file maps to the same UIDs on every import.
 */
async function assignImportUids(cards: { vcard: VCard; text: string }[]): Promise<VCard[]> {
  const explicit = (uid: string) => uid !== '' && !UNSAFE_UID.test(uid)
  const reserved = new Set(cards.map(({ vcard }) => vcard.uid).filter(explicit))
  const assigned = new Set<string>()
  const result: VCard[] = []
  for (const { vcard, text } of cards) {
    let uid = vcard.uid
    if (!explicit(uid) || assigned.has(uid)) {
      const hash = await sha256Hex(text)
      let n = 1
      while (reserved.has(`import-${hash}-${n}`) || assigned.has(`import-${hash}-${n}`)) n++
      uid = `import-${hash}-${n}`
    }
    assigned.add(uid)
    result.push({ ...vcard, uid })
  }
  return result
}

/** Only acknowledged contacts count as imported; an unconfirmed one may still exist remotely. */
function incompleteImportMessage(saved: number, unsaved: number, uncertain: boolean): string {
  const total = saved + unsaved
  if (uncertain) {
    return `Imported ${saved} of ${total} contacts. The other ${unsaved} weren't confirmed as saved and are listed below. If the connection dropped, some may already be saved, so check your list before importing them again.`
  }
  if (saved === 0) return `None of the ${total} contacts were saved. They're listed below so you can import them again.`
  return `Imported ${saved} of ${total} contacts. The other ${unsaved} weren't saved and are listed below so you can import them again.`
}

interface ContactImportProps {
  onImportComplete: (count: number) => void
  heading?: string
}

const PLATFORM_INSTRUCTIONS = [
  {
    name: 'Google Contacts',
    steps: 'Go to contacts.google.com → Export → select vCard (.vcf)',
  },
  {
    name: 'Apple Contacts',
    steps: 'Open Contacts → Select All → File → Export vCard',
  },
  {
    name: 'Outlook',
    steps: 'People → Manage Contacts → Export',
  },
  {
    name: 'Other',
    steps: 'Export your contacts as .vcf from any app',
  },
]

export default function ContactImport({ onImportComplete, heading }: ContactImportProps) {
  const [contacts, setContacts] = useState<VCard[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [importedCount, setImportedCount] = useState<number | null>(null)
  const [openAccordion, setOpenAccordion] = useState<string | null>(null)
  const [providerNotice, setProviderNotice] = useState<string | null>(null)
  const [unreadableNotice, setUnreadableNotice] = useState<string | null>(null)
  // Progress lives in the store, so a page that was left and reopened still shows the running import.
  const runningImport = useContactStore((s) => s.fileImport) ?? null
  const busy = isImporting || runningImport !== null
  // Counted from the current file preview, so a retry that lists only the unsaved contacts never
  // warns about a long note that was already saved.
  const longNotes = hasProviderContacts(contacts) ? 0 : contacts.filter((contact) => (contact.note?.length ?? 0) > LONG_CONTACT_NOTE_CHARS).length
  const longNoteNotice = longNotes === 0
    ? null
    : longNotes === 1
      ? '1 contact has a note over 200,000 characters and may not sync to Android.'
      : `${longNotes} contacts have notes over 200,000 characters and may not sync to Android.`
  // Each file selection and each provider run takes the next token when it starts; its preview,
  // notices and errors count only while that token is still the newest, so a slower, older
  // selection (a file, Google or Microsoft) never replaces a newer one.
  const selection = useRef(0)
  // The token of each provider's current run, never shared between providers. A provider button
  // runs one load at a time and drops a superseded run's callbacks itself.
  const providerRuns = useRef<Record<'Google' | 'Microsoft', number>>({ Google: -1, Microsoft: -1 })
  const startProvider = useCallback((provider: 'Google' | 'Microsoft'): number => {
    const token = ++selection.current
    providerRuns.current[provider] = token
    return token
  }, [])
  const providerIsCurrent = (provider: 'Google' | 'Microsoft') => providerRuns.current[provider] === selection.current
  const importContacts = useContactStore((s) => s.importContacts)
  const contactLists = useContactListStore((s) => s.lists)
  const activeListId = useContactListStore((s) => s.activeListId)
  const initialListId = activeListId !== 'all' ? activeListId : 'default'
  const [selectedListId, setSelectedListId] = useState(initialListId)
  const createCollection = useEtebaseStore((s) => s.createCollection)

  useEffect(() => {
    if (contactLists.length === 0) return
    const fallbackId = activeListId !== 'all' && contactLists.some((list) => list.id === activeListId)
      ? activeListId
      : contactLists[0]!.id
    if (!contactLists.some((list) => list.id === selectedListId)) {
      setSelectedListId(fallbackId)
    }
  }, [activeListId, contactLists, selectedListId])

  const handleFiles = useCallback(async (files: File[]) => {
    setError(null)
    setContacts([])
    setImportedCount(null)
    setProviderNotice(null)
    setUnreadableNotice(null)
    const token = ++selection.current
    const current = () => token === selection.current

    try {
      const readable: { vcard: VCard; text: string }[] = []
      let unreadable = 0
      for (const file of files) {
        if (file.size > MAX_CONTACT_IMPORT_FILE_BYTES) {
          setError('File is too large. Maximum size is 50 MB.')
          return
        }
        const text = await file.text()
        if (!current()) return
        const { cards, incomplete } = splitVCardFile(text)
        unreadable += incomplete
        for (const card of cards) {
          try {
            readable.push({ vcard: parseVCard(card, { strictTextEncoding: true, keepMissingUid: true }), text: card })
          } catch (err) {
            // One unreadable card is skipped and counted; it never rejects the rest.
            console.error('[contact-import] Skipped an unreadable card', getSafeErrorDetails(err))
            unreadable++
          }
        }
      }
      if (readable.length === 0) {
        setError(unreadable > 0 ? 'Failed to parse the file. Please make sure it is a valid .vcf file.' : 'No contacts found in the selected file(s).')
        return
      }
      const assigned = await assignImportUids(readable)
      if (!current()) return
      if (unreadable > 0) setUnreadableNotice(unreadable === 1 ? "1 contact couldn't be read." : `${unreadable} contacts couldn't be read.`)
      setContacts(assigned)
    } catch (err) {
      if (!current()) return
      console.error('[contact-import] Failed to parse VCF file', getSafeErrorDetails(err))
      setError('Failed to parse the file. Please make sure it is a valid .vcf file.')
    }
  }, [])

  const handleProviderLoaded = useCallback((provider: 'Google' | 'Microsoft', loaded: VCard[]) => {
    setError(null)
    setUnreadableNotice(null)
    setImportedCount(null)
    // A first look against what this device shows; the write re-checks against the server.
    const { contacts: pending, skipped } = withoutImported(loaded, importSourceKeys(useContactStore.getState().contacts))
    const notes: string[] = []
    if (pending.length === 0) notes.push(`Nothing new to import from ${provider}.`)
    if (skipped > 0) notes.push(`${skipped} already imported ${skipped === 1 ? 'contact was' : 'contacts were'} skipped.`)
    setProviderNotice(notes.length > 0 ? notes.join(' ') : null)
    setContacts(pending)
  }, [])

  const handleImport = useCallback(async () => {
    setIsImporting(true)
    setError(null)
    let toImport = contacts
    const fromFile = !hasProviderContacts(contacts)
    if (!fromFile) {
      // Read the server first: a save whose acknowledgement was lost is there, though not shown here.
      const onServer = await serverImportSourceKeys('contacts')
      if (!onServer) {
        setError(RECONCILE_FAILED_MESSAGE)
        setIsImporting(false)
        return
      }
      const known = new Set([...importSourceKeys(useContactStore.getState().contacts), ...onServer])
      toImport = withoutImported(contacts, known).contacts
    }
    if (toImport.length === 0) {
      setContacts([])
      setProviderNotice('Everything listed was already imported.')
      setIsImporting(false)
      return
    }
    try {
      const newContacts = toImport.map((contact) => ({
        ...(fromFile ? { uid: contact.uid } : {}),
        displayName: contact.fn || 'Unnamed Contact',
        name: contact.n
          ? {
              given: contact.n.given,
              ...(contact.n.additional ? { additional: contact.n.additional } : {}),
              family: contact.n.family,
              prefix: contact.n.prefix ?? '',
              suffix: contact.n.suffix ?? '',
            }
          : undefined,
        phones: contact.tel?.map((t) => ({ type: t.type, value: t.value })),
        emails: contact.email?.map((e) => ({ type: e.type, value: e.value })),
        addresses: contact.adr?.map((a) => ({
          type: a.type,
          ...(a.poBox ? { poBox: a.poBox } : {}),
          ...(a.extended ? { extended: a.extended } : {}),
          street: a.street,
          city: a.city,
          state: a.state,
          postalCode: a.postalCode,
          country: a.country,
        })),
        organization: contact.org ?? '',
        title: contact.title ?? '',
        notes: contact.note ?? '',
        birthday: contact.bday ?? null,
        birthdayIsText: contact.bdayIsText === true,
        photoUrl: contact.photo ?? null,
        categories: normalizeLabels(contact.categories ?? []),
        favorite: contact.favorite === true,
        unknownProperties: contact.unknownProperties,
        listId: selectedListId,
      }))
      const count = fromFile
        ? await importContacts(newContacts, {
            fileImport: {
              onSkipped: (skipped) => setProviderNotice(`${skipped} already imported ${skipped === 1 ? 'contact was' : 'contacts were'} skipped.`),
            },
          })
        : await importContacts(newContacts)
      if (fromFile && count === 0) {
        // Everything was already on the server; the skipped notice says so.
        setContacts([])
      } else {
        setImportedCount(count)
        onImportComplete(count)
      }
    } catch (err) {
      if (isImportIncomplete(err)) {
        // Keep only the original contacts that were not acknowledged, so a retry never resends saved
        // ones. Positions are original preview positions; skipped cards are never listed again.
        const unsaved = new Set(err.unsaved)
        setContacts(toImport.filter((_, position) => unsaved.has(position)))
        setError(fromFile && err.outcomes ? fileIncompleteMessage(err.outcomes) : incompleteImportMessage(err.saved, err.unsaved.length, err.uncertain))
      } else if (fromFile && isAlreadyRunning(err)) {
        setError('An import into this contact list is already running. Wait for it to finish, then try again.')
      } else if (fromFile && isReconcileFailed(err)) {
        setError(RECONCILE_FAILED_MESSAGE)
      } else {
        console.error('[contact-import] Import failed', getSafeErrorDetails(err))
        setError('An error occurred while importing contacts. Please try again.')
      }
    } finally {
      setIsImporting(false)
    }
  }, [contacts, importContacts, onImportComplete, selectedListId])

  const handleCreateList = useCallback(async (name: string, color: string) => {
    const uid = await createCollection('contacts', name, color)
    if (uid) setSelectedListId(uid)
  }, [createCollection])

  const handleCancel = useCallback(() => {
    selection.current++
    setContacts([])
    setError(null)
    setImportedCount(null)
    setProviderNotice(null)
    setUnreadableNotice(null)
  }, [])

  return (
    <div className="space-y-4">
      {heading && (
        <h2 className="text-lg font-semibold leading-tight text-[rgb(var(--foreground))]">
          {heading}
        </h2>
      )}
      <div className="space-y-1 rounded-lg bg-[rgb(var(--surface))]/50 p-1">
        {PLATFORM_INSTRUCTIONS.map((platform) => (
          <div key={platform.name}>
            <button
              type="button"
              onClick={() =>
                setOpenAccordion(openAccordion === platform.name ? null : platform.name)
              }
              className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))]/50"
            >
              <span>{platform.name}</span>
              <ChevronDown
                className={`h-4 w-4 text-[rgb(var(--muted))] transition-transform ${
                  openAccordion === platform.name ? 'rotate-180' : ''
                }`}
              />
            </button>
            {openAccordion === platform.name && (
              <p className="px-3 pb-2 text-xs text-[rgb(var(--muted))]">{platform.steps}</p>
            )}
          </div>
        ))}
      </div>

      <ImportListSelector
        lists={contactLists}
        selectedId={selectedListId}
        onSelect={setSelectedListId}
        onCreateNew={handleCreateList}
        label="contact list"
      />

      <FileDropZone accept=".vcf" onFiles={handleFiles} disabled={busy} />

      <GoogleImportButton kind="contacts" disabled={busy} onStart={() => { startProvider('Google') }} onLoaded={(loaded) => { if (providerIsCurrent('Google')) handleProviderLoaded('Google', loaded) }} onError={(message) => { if (providerIsCurrent('Google')) setError(message) }} />

      <MicrosoftImportButton kind="contacts" disabled={busy} onStart={() => { startProvider('Microsoft') }} onLoaded={(loaded) => { if (providerIsCurrent('Microsoft')) handleProviderLoaded('Microsoft', loaded) }} onError={(message) => { if (providerIsCurrent('Microsoft')) setError(message) }} />

      {runningImport && !isImporting && (
        // Reopened while an import started earlier is still running: show it instead of an idle form.
        <button
          type="button"
          disabled
          className="inline-flex items-center gap-2 rounded-lg bg-[rgb(var(--primary-strong))] px-4 py-2 text-sm font-medium text-white opacity-50"
        >
          {`Importing ${runningImport.saved} of ${runningImport.total}…`}
        </button>
      )}

      {providerNotice && (
        <p className="rounded-md bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--muted))]">{providerNotice}</p>
      )}

      {unreadableNotice && (
        <p className="rounded-md bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--muted))]">{unreadableNotice}</p>
      )}

      {longNoteNotice && (
        <p className="rounded-md bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--muted))]">{longNoteNotice}</p>
      )}

      {error && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>
      )}

      {contacts.length > 0 && (
        <ImportPreview
          items={contacts.map((c) => ({
            title: c.fn || 'Unnamed Contact',
            subtitle: c.email?.[0]?.value ?? c.tel?.[0]?.value,
          }))}
          type="contacts"
          onImport={handleImport}
          onCancel={handleCancel}
          isImporting={isImporting}
          importedCount={importedCount}
          progress={runningImport}
        />
      )}

      {contacts.length === 0 && importedCount !== null && (
        <ImportPreview
          items={[]}
          type="contacts"
          onImport={handleImport}
          onCancel={handleCancel}
          isImporting={false}
          importedCount={importedCount}
        />
      )}
    </div>
  )
}
