'use client'

import { useCallback, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { parseVCard } from '@silentsuite/core/utils/vcard-parser'
import type { VCard } from '@silentsuite/core/utils/vcard-parser'
import FileDropZone from './FileDropZone'
import ImportPreview from './ImportPreview'
import { useContactStore } from '@/app/stores/use-contact-store'

interface ContactImportProps {
  onImportComplete: (count: number) => void
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

/** Split a multi-vCard file into individual vCard strings */
function splitVCards(text: string): string[] {
  const cards: string[] = []
  const lines = text.split(/\r?\n/)
  let current: string[] = []
  let inCard = false

  for (const line of lines) {
    if (line.trim().toUpperCase() === 'BEGIN:VCARD') {
      inCard = true
      current = [line]
    } else if (line.trim().toUpperCase() === 'END:VCARD') {
      current.push(line)
      cards.push(current.join('\r\n'))
      inCard = false
      current = []
    } else if (inCard) {
      current.push(line)
    }
  }

  return cards
}

export default function ContactImport({ onImportComplete }: ContactImportProps) {
  const [contacts, setContacts] = useState<VCard[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [importedCount, setImportedCount] = useState<number | null>(null)
  const [openAccordion, setOpenAccordion] = useState<string | null>(null)
  const createContact = useContactStore((s) => s.createContact)

  const handleFiles = useCallback(async (files: File[]) => {
    setError(null)
    setContacts([])
    setImportedCount(null)

    try {
      const allContacts: VCard[] = []
      for (const file of files) {
        const text = await file.text()
        const vcardStrings = splitVCards(text)
        for (const vcStr of vcardStrings) {
          allContacts.push(parseVCard(vcStr))
        }
      }
      if (allContacts.length === 0) {
        setError('No contacts found in the selected file(s).')
        return
      }
      setContacts(allContacts)
    } catch {
      setError('Failed to parse the file. Please make sure it is a valid .vcf file.')
    }
  }, [])

  const handleImport = useCallback(async () => {
    setIsImporting(true)
    try {
      for (const contact of contacts) {
        await createContact({
          displayName: contact.fn || 'Unnamed Contact',
          name: contact.n
            ? {
                given: contact.n.given,
                family: contact.n.family,
                prefix: contact.n.prefix ?? '',
                suffix: contact.n.suffix ?? '',
              }
            : undefined,
          phones: contact.tel?.map((t) => ({ type: t.type, value: t.value })),
          emails: contact.email?.map((e) => ({ type: e.type, value: e.value })),
          addresses: contact.adr?.map((a) => ({
            type: a.type,
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
          photoUrl: contact.photo ?? null,
        })
      }
      setImportedCount(contacts.length)
      onImportComplete(contacts.length)
    } catch {
      setError('An error occurred while importing contacts. Please try again.')
    } finally {
      setIsImporting(false)
    }
  }, [contacts, createContact, onImportComplete])

  const handleCancel = useCallback(() => {
    setContacts([])
    setError(null)
    setImportedCount(null)
  }, [])

  return (
    <div className="space-y-4">
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

      <FileDropZone accept=".vcf" onFiles={handleFiles} />

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
