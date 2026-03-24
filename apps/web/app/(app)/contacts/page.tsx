'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Search, ArrowLeft, Phone, Mail, MapPin, Building2, Cake,
  StickyNote, User, WifiOff, Plus, Trash2, X, Pencil, Camera, BookUser,
} from 'lucide-react'
import { useContactStore, getFilteredContacts } from '@/app/stores/use-contact-store'
import { useContactListStore } from '@/app/stores/use-contact-list-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { useSyncStore } from '@/app/stores/use-sync-store'
import { ListSwitcher } from '@/app/components/ListSwitcher'
import { ContactsEmptyState, SearchEmptyState, ContactDetailEmptyState } from '@/app/components/empty-state'
import { ConfirmDialog } from '@/app/components/confirm-dialog'
import type { Contact } from '@silentsuite/core'

// ── Helpers ──

function getInitials(contact: Contact): string {
  const { given, family } = contact.name
  if (given && family) return `${given[0]}${family[0]}`.toUpperCase()
  if (given) return given[0]!.toUpperCase()
  if (family) return family[0]!.toUpperCase()
  const parts = contact.displayName.trim().split(/\s+/)
  if (parts.length >= 2) return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase()
  if (parts[0]) return parts[0][0]!.toUpperCase()
  return '?'
}

function nameColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  const colors = [
    'bg-emerald-600', 'bg-blue-600', 'bg-purple-600', 'bg-pink-600',
    'bg-amber-600', 'bg-cyan-600', 'bg-rose-600', 'bg-indigo-600',
  ]
  return colors[Math.abs(hash) % colors.length]!
}

function sortContacts(contacts: Contact[]): Contact[] {
  return [...contacts].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
  )
}

const INPUT_CLASS =
  'w-full rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-1.5 text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:outline-none focus:ring-1 focus:ring-emerald-500'

// ── Photo processing ──

async function processContactPhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new window.Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        const MAX_SIZE = 256
        let { width, height } = img
        if (width > height) {
          if (width > MAX_SIZE) { height = (height * MAX_SIZE) / width; width = MAX_SIZE }
        } else {
          if (height > MAX_SIZE) { width = (width * MAX_SIZE) / height; height = MAX_SIZE }
        }
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0, width, height)
        resolve(canvas.toDataURL('image/jpeg', 0.8))
      }
      img.onerror = reject
      img.src = e.target?.result as string
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// ── ContactAvatar ──

function ContactAvatar({
  contact,
  size = 'md',
  className = '',
}: {
  contact: Pick<Contact, 'displayName' | 'photoUrl' | 'name'>
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const sizeClasses = {
    sm: 'h-9 w-9 text-sm',
    md: 'h-16 w-16 text-2xl',
    lg: 'h-20 w-20 text-2xl',
  }

  if (contact.photoUrl) {
    return (
      <img
        src={contact.photoUrl}
        alt={contact.displayName}
        className={`${sizeClasses[size]} shrink-0 rounded-full object-cover ${className}`}
      />
    )
  }

  const initials = (() => {
    const { given, family } = contact.name
    if (given && family) return `${given[0]}${family[0]}`.toUpperCase()
    if (given) return given[0]!.toUpperCase()
    if (family) return family[0]!.toUpperCase()
    const parts = contact.displayName.trim().split(/\s+/)
    if (parts.length >= 2) return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase()
    if (parts[0]) return parts[0][0]!.toUpperCase()
    return '?'
  })()

  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${sizeClasses[size]} ${nameColor(contact.displayName)} ${className}`}
    >
      {initials}
    </div>
  )
}

const PHONE_TYPES = ['cell', 'home', 'work', 'other']
const EMAIL_TYPES = ['home', 'work', 'other']
const ADDRESS_TYPES = ['home', 'work', 'other']

// ── SearchBar ──

function SearchBar() {
  const searchQuery = useContactStore((s) => s.searchQuery)
  const setSearchQuery = useContactStore((s) => s.setSearchQuery)

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[rgb(var(--muted))]" />
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="Search contacts..."
        className="w-full rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] pl-9 pr-3 py-2 text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
      />
    </div>
  )
}

// ── ContactListItem ──

function ContactListItem({
  contact,
  isSelected,
  onSelect,
}: {
  contact: Contact
  isSelected: boolean
  onSelect: () => void
}) {
  const primaryEmail = contact.emails[0]?.value ?? ''
  const primaryPhone = contact.phones[0]?.value ?? ''

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
        isSelected
          ? 'bg-emerald-600/15 border border-emerald-500/30'
          : 'border border-transparent hover:bg-[rgb(var(--surface))]'
      }`}
    >
      <ContactAvatar contact={contact} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-[rgb(var(--foreground))]">
          {contact.displayName}
        </div>
        <div className="truncate text-xs text-[rgb(var(--muted))]">
          {primaryEmail || primaryPhone || ''}
        </div>
      </div>
    </button>
  )
}

// ── TypeSelector ──

function TypeSelector({
  value,
  options,
  onChange,
}: {
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-2 py-1.5 text-xs text-[rgb(var(--foreground))] focus:outline-none focus:ring-1 focus:ring-emerald-500"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o.charAt(0).toUpperCase() + o.slice(1)}
        </option>
      ))}
    </select>
  )
}

// ── ContactForm (New Contact modal) ──

function ContactForm({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: (id: string) => void
}) {
  const createContact = useContactStore((s) => s.createContact)
  const contactLists = useContactListStore((s) => s.lists)
  const activeListId = useContactListStore((s) => s.activeListId)
  const photoInputRef = useRef<HTMLInputElement>(null)

  const [selectedListId, setSelectedListId] = useState(activeListId === 'all' ? 'default' : activeListId)
  const [given, setGiven] = useState('')
  const [family, setFamily] = useState('')
  const [prefix, setPrefix] = useState('')
  const [suffix, setSuffix] = useState('')
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [phones, setPhones] = useState<Array<{ type: string; value: string }>>([
    { type: 'cell', value: '' },
  ])
  const [emails, setEmails] = useState<Array<{ type: string; value: string }>>([
    { type: 'home', value: '' },
  ])
  const [addresses, setAddresses] = useState<Contact['addresses']>([])
  const [organization, setOrganization] = useState('')
  const [title, setTitle] = useState('')
  const [birthday, setBirthday] = useState('')
  const [notes, setNotes] = useState('')

  const handlePhotoChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const dataUrl = await processContactPhoto(file)
      setPhotoUrl(dataUrl)
    } catch (err) {
      console.error('[contacts] Failed to process photo:', err)
    }
    // Reset so the same file can be re-selected
    e.target.value = ''
  }, [])

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const displayName = [given, family].filter(Boolean).join(' ') || 'Unnamed Contact'
      const contact = await createContact({
        displayName,
        name: { prefix, given, family, suffix },
        phones: phones.filter((p) => p.value.trim()),
        emails: emails.filter((em) => em.value.trim()),
        addresses: addresses.filter((a) => a.street.trim() || a.city.trim()),
        organization,
        title,
        birthday: birthday || null,
        notes,
        photoUrl,
        listId: selectedListId,
      })
      onSaved(contact.id)
    },
    [given, family, prefix, suffix, phones, emails, addresses, organization, title, birthday, notes, photoUrl, selectedListId, createContact, onSaved],
  )

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 md:items-start md:p-4 md:pt-16">
      <div className="w-full max-h-[92vh] overflow-y-auto rounded-t-2xl border-t border-[rgb(var(--border))] bg-[rgb(var(--background))] px-4 pb-8 pt-3 shadow-2xl md:max-w-lg md:rounded-xl md:border md:p-6">
        {/* Drag indicator (mobile) */}
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[rgb(var(--border))] md:hidden" />
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-[rgb(var(--foreground))]">New Contact</h3>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Avatar / Photo */}
          <input type="file" ref={photoInputRef} accept="image/*" onChange={handlePhotoChange} className="hidden" />
          <div className="flex justify-center pb-2">
            <button
              type="button"
              onClick={() => photoInputRef.current?.click()}
              className="group relative flex h-20 w-20 items-center justify-center rounded-full bg-emerald-600 text-2xl font-semibold text-white transition-opacity"
              aria-label="Add photo"
            >
              {photoUrl ? (
                <img src={photoUrl} alt="Contact photo" className="h-20 w-20 rounded-full object-cover" />
              ) : given || family ? (
                <span>
                  {(given?.[0] ?? '').toUpperCase()}
                  {(family?.[0] ?? '').toUpperCase()}
                </span>
              ) : (
                <User className="h-8 w-8" />
              )}
              {/* Hover overlay */}
              <div className="absolute inset-0 flex flex-col items-center justify-center rounded-full bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                <Camera className="h-4 w-4 text-white" />
                <span className="mt-0.5 text-[10px] font-medium text-white">{photoUrl ? 'Change' : 'Add photo'}</span>
              </div>
            </button>
          </div>

          {/* Name */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium uppercase tracking-wide text-[rgb(var(--muted))]">Name</legend>
            <input value={given} onChange={(e) => setGiven(e.target.value)} placeholder="Given name *" className={INPUT_CLASS} autoFocus />
            <input value={family} onChange={(e) => setFamily(e.target.value)} placeholder="Family name" className={INPUT_CLASS} />
            <div className="grid grid-cols-2 gap-2">
              <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="Prefix (e.g. Dr.)" className={INPUT_CLASS} />
              <input value={suffix} onChange={(e) => setSuffix(e.target.value)} placeholder="Suffix (e.g. Jr.)" className={INPUT_CLASS} />
            </div>
          </fieldset>

          {/* Phones */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium uppercase tracking-wide text-[rgb(var(--muted))]">Phone</legend>
            {phones.map((p, i) => (
              <div key={i} className="flex gap-2">
                <TypeSelector value={p.type} options={PHONE_TYPES} onChange={(t) => { const next = [...phones]; next[i] = { ...p, type: t }; setPhones(next) }} />
                <input value={p.value} onChange={(e) => { const next = [...phones]; next[i] = { ...p, value: e.target.value }; setPhones(next) }} placeholder="Phone number" className={INPUT_CLASS} />
                {phones.length > 1 && (
                  <button type="button" onClick={() => setPhones(phones.filter((_, j) => j !== i))} className="shrink-0 rounded p-1 text-[rgb(var(--muted))] hover:text-red-400">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
            <button type="button" onClick={() => setPhones([...phones, { type: 'cell', value: '' }])} className="text-xs text-emerald-400 hover:text-emerald-300">
              + Add phone
            </button>
          </fieldset>

          {/* Emails */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium uppercase tracking-wide text-[rgb(var(--muted))]">Email</legend>
            {emails.map((em, i) => (
              <div key={i} className="flex gap-2">
                <TypeSelector value={em.type} options={EMAIL_TYPES} onChange={(t) => { const next = [...emails]; next[i] = { ...em, type: t }; setEmails(next) }} />
                <input value={em.value} onChange={(e) => { const next = [...emails]; next[i] = { ...em, value: e.target.value }; setEmails(next) }} placeholder="Email address" className={INPUT_CLASS} />
                {emails.length > 1 && (
                  <button type="button" onClick={() => setEmails(emails.filter((_, j) => j !== i))} className="shrink-0 rounded p-1 text-[rgb(var(--muted))] hover:text-red-400">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
            <button type="button" onClick={() => setEmails([...emails, { type: 'home', value: '' }])} className="text-xs text-emerald-400 hover:text-emerald-300">
              + Add email
            </button>
          </fieldset>

          {/* Addresses */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium uppercase tracking-wide text-[rgb(var(--muted))]">Address</legend>
            {addresses.map((a, i) => (
              <div key={i} className="space-y-1.5 rounded-md border border-[rgb(var(--border))] p-2">
                <div className="flex items-center justify-between">
                  <TypeSelector value={a.type} options={ADDRESS_TYPES} onChange={(t) => { const next = [...addresses]; next[i] = { ...a, type: t }; setAddresses(next) }} />
                  <button type="button" onClick={() => setAddresses(addresses.filter((_, j) => j !== i))} className="rounded p-1 text-[rgb(var(--muted))] hover:text-red-400">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <input value={a.street} onChange={(e) => { const next = [...addresses]; next[i] = { ...a, street: e.target.value }; setAddresses(next) }} placeholder="Street" className={INPUT_CLASS} />
                <div className="grid grid-cols-2 gap-1.5">
                  <input value={a.city} onChange={(e) => { const next = [...addresses]; next[i] = { ...a, city: e.target.value }; setAddresses(next) }} placeholder="City" className={INPUT_CLASS} />
                  <input value={a.state} onChange={(e) => { const next = [...addresses]; next[i] = { ...a, state: e.target.value }; setAddresses(next) }} placeholder="State" className={INPUT_CLASS} />
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <input value={a.postalCode} onChange={(e) => { const next = [...addresses]; next[i] = { ...a, postalCode: e.target.value }; setAddresses(next) }} placeholder="Postal code" className={INPUT_CLASS} />
                  <input value={a.country} onChange={(e) => { const next = [...addresses]; next[i] = { ...a, country: e.target.value }; setAddresses(next) }} placeholder="Country" className={INPUT_CLASS} />
                </div>
              </div>
            ))}
            <button type="button" onClick={() => setAddresses([...addresses, { type: 'home', street: '', city: '', state: '', postalCode: '', country: '' }])} className="text-xs text-emerald-400 hover:text-emerald-300">
              + Add address
            </button>
          </fieldset>

          {/* Organization & Title */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium uppercase tracking-wide text-[rgb(var(--muted))]">Work</legend>
            <input value={organization} onChange={(e) => setOrganization(e.target.value)} placeholder="Organization" className={INPUT_CLASS} />
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Job title" className={INPUT_CLASS} />
          </fieldset>

          {/* Address Book selector */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium uppercase tracking-wide text-[rgb(var(--muted))]">Address Book</legend>
            <div className="flex items-center gap-3">
              <BookUser className="h-4 w-4 shrink-0 text-[rgb(var(--muted))]" />
              <select
                value={selectedListId}
                onChange={(e) => setSelectedListId(e.target.value)}
                aria-label="Address book"
                className="flex-1 rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                {contactLists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </select>
            </div>
          </fieldset>

          {/* Birthday & Notes */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium uppercase tracking-wide text-[rgb(var(--muted))]">Personal</legend>
            <input type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} className={INPUT_CLASS} />
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" rows={3} className={`${INPUT_CLASS} resize-none`} />
          </fieldset>

          {/* Actions */}
          <div className="flex gap-3 pt-4">
            <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-[rgb(var(--border))] px-4 py-2.5 text-sm font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] transition-colors md:flex-initial">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!given.trim() && !family.trim()}
              className="flex-1 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors md:flex-initial"
            >
              Save Contact
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── DetailSection ──

function DetailSection({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[rgb(var(--muted))]">
        {icon}
        {title}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

// ── EditableField (auto-save on blur) ──

function EditableField({
  value,
  onChange,
  placeholder,
  type = 'text',
  multiline = false,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  type?: string
  multiline?: boolean
}) {
  const [localValue, setLocalValue] = useState(value)
  const didMount = useRef(false)

  useEffect(() => {
    setLocalValue(value)
  }, [value])

  const handleBlur = useCallback(() => {
    if (localValue !== value) {
      onChange(localValue)
    }
  }, [localValue, value, onChange])

  if (multiline) {
    return (
      <textarea
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={handleBlur}
        placeholder={placeholder}
        rows={3}
        className={`${INPUT_CLASS} resize-none`}
      />
    )
  }

  return (
    <input
      type={type}
      value={localValue}
      onChange={(e) => setLocalValue(e.target.value)}
      onBlur={handleBlur}
      placeholder={placeholder}
      className={INPUT_CLASS}
    />
  )
}

// ── ContactDetail (with edit + delete) ──

function ContactDetail({
  contact,
  onBack,
  onDeleted,
}: {
  contact: Contact
  onBack: () => void
  onDeleted: () => void
}) {
  const updateContact = useContactStore((s) => s.updateContact)
  const deleteContact = useContactStore((s) => s.deleteContact)
  const canWrite = useAuthStore((s) => s.canWrite())
  const photoInputRef = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const handlePhotoChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const dataUrl = await processContactPhoto(file)
      updateContact(contact.id, { photoUrl: dataUrl })
    } catch (err) {
      console.error('[contacts] Failed to process photo:', err)
    }
    e.target.value = ''
  }, [contact.id, updateContact])

  const handleFieldUpdate = useCallback(
    (patch: Partial<Contact>) => {
      updateContact(contact.id, patch)
    },
    [contact.id, updateContact],
  )

  const handleNameUpdate = useCallback(
    (field: keyof Contact['name'], value: string) => {
      const newName = { ...contact.name, [field]: value }
      const displayName = [newName.given, newName.family].filter(Boolean).join(' ') || 'Unnamed Contact'
      updateContact(contact.id, { name: newName, displayName })
    },
    [contact.id, contact.name, updateContact],
  )

  const handleDeleteConfirmed = useCallback(() => {
    deleteContact(contact.id)
    setConfirmDelete(false)
    onDeleted()
  }, [contact.id, deleteContact, onDeleted])

  const handlePhoneUpdate = useCallback(
    (index: number, field: 'type' | 'value', val: string) => {
      const next = [...contact.phones]
      next[index] = { ...next[index]!, [field]: val }
      updateContact(contact.id, { phones: next })
    },
    [contact.id, contact.phones, updateContact],
  )

  const handleEmailUpdate = useCallback(
    (index: number, field: 'type' | 'value', val: string) => {
      const next = [...contact.emails]
      next[index] = { ...next[index]!, [field]: val }
      updateContact(contact.id, { emails: next })
    },
    [contact.id, contact.emails, updateContact],
  )

  const handleAddPhone = useCallback(() => {
    updateContact(contact.id, { phones: [...contact.phones, { type: 'cell', value: '' }] })
  }, [contact.id, contact.phones, updateContact])

  const handleAddEmail = useCallback(() => {
    updateContact(contact.id, { emails: [...contact.emails, { type: 'home', value: '' }] })
  }, [contact.id, contact.emails, updateContact])

  const handleRemovePhone = useCallback(
    (index: number) => {
      updateContact(contact.id, { phones: contact.phones.filter((_, i) => i !== index) })
    },
    [contact.id, contact.phones, updateContact],
  )

  const handleRemoveEmail = useCallback(
    (index: number) => {
      updateContact(contact.id, { emails: contact.emails.filter((_, i) => i !== index) })
    },
    [contact.id, contact.emails, updateContact],
  )

  const handleAddAddress = useCallback(() => {
    updateContact(contact.id, {
      addresses: [...contact.addresses, { type: 'home', street: '', city: '', state: '', postalCode: '', country: '' }],
    })
  }, [contact.id, contact.addresses, updateContact])

  const handleRemoveAddress = useCallback(
    (index: number) => {
      updateContact(contact.id, { addresses: contact.addresses.filter((_, i) => i !== index) })
    },
    [contact.id, contact.addresses, updateContact],
  )

  const handleAddressUpdate = useCallback(
    (index: number, field: string, val: string) => {
      const next = [...contact.addresses]
      next[index] = { ...next[index]!, [field]: val }
      updateContact(contact.id, { addresses: next })
    },
    [contact.id, contact.addresses, updateContact],
  )

  const deleteConfirmDialog = confirmDelete ? (
    <ConfirmDialog
      title="Delete contact?"
      message={`"${contact.displayName}" will be permanently deleted along with all their information.`}
      confirmLabel="Delete contact"
      onConfirm={handleDeleteConfirmed}
      onCancel={() => setConfirmDelete(false)}
    />
  ) : null

  // ── Read-only view ──
  if (!editing) {
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        <div className="flex items-center justify-between md:justify-end">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 px-1 py-2 text-sm text-emerald-400 hover:text-emerald-300 md:hidden"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <div className="flex items-center gap-1">
            {canWrite && (
              <>
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="rounded p-1.5 text-[rgb(var(--muted))] hover:text-emerald-400 transition-colors"
                  aria-label="Edit contact"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="rounded p-1.5 text-[rgb(var(--muted))] hover:text-red-400 transition-colors"
                  aria-label="Delete contact"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Header */}
        <input type="file" ref={photoInputRef} accept="image/*" onChange={handlePhotoChange} className="hidden" />
        <div className="flex flex-col items-center gap-3 pb-6 pt-2">
          <button
            type="button"
            onClick={() => canWrite && photoInputRef.current?.click()}
            className="group relative flex h-16 w-16 items-center justify-center rounded-full text-2xl font-semibold text-white"
            aria-label={contact.photoUrl ? 'Change photo' : 'Add photo'}
          >
            <ContactAvatar contact={contact} size="md" />
            {/* Hover overlay */}
            {canWrite && (
              <div className="absolute inset-0 flex flex-col items-center justify-center rounded-full bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                <Camera className="h-4 w-4 text-white" />
                <span className="mt-0.5 text-[10px] font-medium text-white">{contact.photoUrl ? 'Change' : 'Add photo'}</span>
              </div>
            )}
          </button>
          <div className="text-center">
            <h3 className="text-lg font-semibold text-[rgb(var(--foreground))]">{contact.displayName}</h3>
            {(contact.organization || contact.title) && (
              <p className="text-sm text-[rgb(var(--muted))]">
                {[contact.title, contact.organization].filter(Boolean).join(' at ')}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-5">
          {contact.phones.length > 0 && (
            <DetailSection icon={<Phone className="h-4 w-4" />} title="Phone">
              {contact.phones.map((p, i) => (
                <div key={i} className="text-sm text-[rgb(var(--foreground))]">
                  <span className="text-[rgb(var(--muted))] capitalize">{p.type}:</span> {p.value}
                </div>
              ))}
            </DetailSection>
          )}
          {contact.emails.length > 0 && (
            <DetailSection icon={<Mail className="h-4 w-4" />} title="Email">
              {contact.emails.map((e, i) => (
                <div key={i} className="text-sm text-[rgb(var(--foreground))]">
                  <span className="text-[rgb(var(--muted))] capitalize">{e.type}:</span> {e.value}
                </div>
              ))}
            </DetailSection>
          )}
          {contact.addresses.length > 0 && (
            <DetailSection icon={<MapPin className="h-4 w-4" />} title="Address">
              {contact.addresses.map((a, i) => (
                <div key={i} className="text-sm text-[rgb(var(--foreground))]">
                  <span className="text-[rgb(var(--muted))] capitalize">{a.type}:</span>{' '}
                  {[a.street, a.city, a.state, a.postalCode, a.country].filter(Boolean).join(', ')}
                </div>
              ))}
            </DetailSection>
          )}
          {(contact.organization || contact.title) && (
            <DetailSection icon={<Building2 className="h-4 w-4" />} title="Work">
              {contact.organization && (
                <div className="text-sm text-[rgb(var(--foreground))]">
                  <span className="text-[rgb(var(--muted))]">Organization:</span> {contact.organization}
                </div>
              )}
              {contact.title && (
                <div className="text-sm text-[rgb(var(--foreground))]">
                  <span className="text-[rgb(var(--muted))]">Title:</span> {contact.title}
                </div>
              )}
            </DetailSection>
          )}
          {(contact.birthday || contact.notes) && (
            <DetailSection icon={<User className="h-4 w-4" />} title="Personal">
              {contact.birthday && (
                <div className="flex items-center gap-2 text-sm text-[rgb(var(--foreground))]">
                  <Cake className="h-3.5 w-3.5 text-[rgb(var(--muted))]" />
                  {contact.birthday}
                </div>
              )}
              {contact.notes && (
                <div className="flex items-start gap-2 text-sm text-[rgb(var(--foreground))]">
                  <StickyNote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[rgb(var(--muted))]" />
                  <span className="whitespace-pre-wrap">{contact.notes}</span>
                </div>
              )}
            </DetailSection>
          )}
        </div>
        {deleteConfirmDialog}
      </div>
    )
  }

  // ── Edit view (auto-save on blur) ──
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center justify-between md:justify-end">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 px-1 py-2 text-sm text-emerald-400 hover:text-emerald-300 md:hidden"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded-md px-3 py-1 text-xs font-medium text-emerald-400 hover:text-emerald-300 border border-emerald-500/30"
          >
            Done
          </button>
          {canWrite && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="rounded p-1.5 text-[rgb(var(--muted))] hover:text-red-400 transition-colors"
              aria-label="Delete contact"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          </div>
        </div>

        {/* Header (avatar) */}
      <div className="flex flex-col items-center gap-3 pb-4 pt-2">
        <button
          type="button"
          onClick={() => photoInputRef.current?.click()}
          className="group relative flex h-16 w-16 items-center justify-center rounded-full text-2xl font-semibold text-white"
          aria-label={contact.photoUrl ? 'Change photo' : 'Add photo'}
        >
          <ContactAvatar contact={contact} size="md" />
          {/* Hover overlay */}
          <div className="absolute inset-0 flex flex-col items-center justify-center rounded-full bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
            <Camera className="h-4 w-4 text-white" />
            <span className="mt-0.5 text-[10px] font-medium text-white">{contact.photoUrl ? 'Change' : 'Add photo'}</span>
          </div>
        </button>
      </div>

      <div className="space-y-5">
        {/* Name */}
        <DetailSection icon={<User className="h-4 w-4" />} title="Name">
          <EditableField value={contact.name.given} onChange={(v) => handleNameUpdate('given', v)} placeholder="Given name" />
          <EditableField value={contact.name.family} onChange={(v) => handleNameUpdate('family', v)} placeholder="Family name" />
          <div className="grid grid-cols-2 gap-2">
            <EditableField value={contact.name.prefix} onChange={(v) => handleNameUpdate('prefix', v)} placeholder="Prefix (e.g. Dr.)" />
            <EditableField value={contact.name.suffix} onChange={(v) => handleNameUpdate('suffix', v)} placeholder="Suffix (e.g. Jr.)" />
          </div>
        </DetailSection>

        {/* Phones */}
        <DetailSection icon={<Phone className="h-4 w-4" />} title="Phone">
          {contact.phones.map((p, i) => (
            <div key={i} className="flex gap-2">
              <TypeSelector value={p.type} options={PHONE_TYPES} onChange={(t) => handlePhoneUpdate(i, 'type', t)} />
              <EditableField value={p.value} onChange={(v) => handlePhoneUpdate(i, 'value', v)} placeholder="Phone number" />
              {canWrite && (
                <button type="button" onClick={() => handleRemovePhone(i)} className="shrink-0 rounded p-1 text-[rgb(var(--muted))] hover:text-red-400">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          {canWrite && (
            <button type="button" onClick={handleAddPhone} className="text-xs text-emerald-400 hover:text-emerald-300">
              + Add phone
            </button>
          )}
        </DetailSection>

        {/* Emails */}
        <DetailSection icon={<Mail className="h-4 w-4" />} title="Email">
          {contact.emails.map((em, i) => (
            <div key={i} className="flex gap-2">
              <TypeSelector value={em.type} options={EMAIL_TYPES} onChange={(t) => handleEmailUpdate(i, 'type', t)} />
              <EditableField value={em.value} onChange={(v) => handleEmailUpdate(i, 'value', v)} placeholder="Email address" />
              {canWrite && (
                <button type="button" onClick={() => handleRemoveEmail(i)} className="shrink-0 rounded p-1 text-[rgb(var(--muted))] hover:text-red-400">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          {canWrite && (
            <button type="button" onClick={handleAddEmail} className="text-xs text-emerald-400 hover:text-emerald-300">
              + Add email
            </button>
          )}
        </DetailSection>

        {/* Addresses */}
        <DetailSection icon={<MapPin className="h-4 w-4" />} title="Address">
          {contact.addresses.map((a, i) => (
            <div key={i} className="space-y-1.5 rounded-md border border-[rgb(var(--border))] p-2">
              <div className="flex items-center justify-between">
                <TypeSelector value={a.type} options={ADDRESS_TYPES} onChange={(t) => handleAddressUpdate(i, 'type', t)} />
                {canWrite && (
                  <button type="button" onClick={() => handleRemoveAddress(i)} className="rounded p-1 text-[rgb(var(--muted))] hover:text-red-400">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              <EditableField value={a.street} onChange={(v) => handleAddressUpdate(i, 'street', v)} placeholder="Street" />
              <div className="grid grid-cols-2 gap-1.5">
                <EditableField value={a.city} onChange={(v) => handleAddressUpdate(i, 'city', v)} placeholder="City" />
                <EditableField value={a.state} onChange={(v) => handleAddressUpdate(i, 'state', v)} placeholder="State" />
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <EditableField value={a.postalCode} onChange={(v) => handleAddressUpdate(i, 'postalCode', v)} placeholder="Postal code" />
                <EditableField value={a.country} onChange={(v) => handleAddressUpdate(i, 'country', v)} placeholder="Country" />
              </div>
            </div>
          ))}
          {canWrite && (
            <button type="button" onClick={handleAddAddress} className="text-xs text-emerald-400 hover:text-emerald-300">
              + Add address
            </button>
          )}
        </DetailSection>

        {/* Work */}
        <DetailSection icon={<Building2 className="h-4 w-4" />} title="Work">
          <EditableField value={contact.organization} onChange={(v) => handleFieldUpdate({ organization: v })} placeholder="Organization" />
          <EditableField value={contact.title} onChange={(v) => handleFieldUpdate({ title: v })} placeholder="Job title" />
        </DetailSection>

        {/* Personal */}
        <DetailSection icon={<Cake className="h-4 w-4" />} title="Personal">
          <EditableField
            value={contact.birthday ?? ''}
            onChange={(v) => handleFieldUpdate({ birthday: v || null })}
            placeholder="Birthday"
            type="date"
          />
          <EditableField
            value={contact.notes}
            onChange={(v) => handleFieldUpdate({ notes: v })}
            placeholder="Notes"
            multiline
          />
        </DetailSection>
      </div>
      {deleteConfirmDialog}
    </div>
  )
}

// ── Skeleton ──

function ContactSkeleton() {
  return (
    <div className="space-y-1">
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg px-3 py-2.5">
          <div className="h-9 w-9 rounded-full skeleton-shimmer" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 rounded skeleton-shimmer" style={{ width: `${40 + i * 8}%` }} />
            <div className="h-3 rounded skeleton-shimmer" style={{ width: `${50 + i * 6}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Page ──

export default function ContactsPage() {
  const canWrite = useAuthStore((s) => s.canWrite())
  const contacts = useContactStore((s) => s.contacts)
  const isLoading = useContactStore((s) => s.isLoading)
  const searchQuery = useContactStore((s) => s.searchQuery)
  const isOnline = useSyncStore((s) => s.isOnline)
  const contactLists = useContactListStore((s) => s.lists)
  const activeListId = useContactListStore((s) => s.activeListId)
  const setActiveList = useContactListStore((s) => s.setActiveList)
  const addContactList = useContactListStore((s) => s.addList)
  const removeContactList = useContactListStore((s) => s.removeList)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showNewForm, setShowNewForm] = useState(false)

  // Filter contacts by active list ('all' shows everything)
  const listFilteredContacts = useMemo(
    () => activeListId === 'all'
      ? contacts
      : contacts.filter((c) => (c.listId ?? 'default') === activeListId),
    [contacts, activeListId],
  )

  const filtered = useMemo(
    () => sortContacts(getFilteredContacts(listFilteredContacts, searchQuery)),
    [listFilteredContacts, searchQuery],
  )

  const selectedContact = useMemo(
    () => contacts.find((c) => c.id === selectedId) ?? null,
    [contacts, selectedId],
  )

  const isEmpty = listFilteredContacts.length === 0 && !isLoading
  const isEmptySearch = filtered.length === 0 && searchQuery.trim() !== '' && !isLoading

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Offline banner */}
      {!isOnline && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          <WifiOff className="h-3.5 w-3.5 shrink-0" />
          You are offline. Changes will sync when reconnected.
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-[rgb(var(--foreground))]">Contacts</h2>
          <ListSwitcher
            lists={contactLists}
            activeListId={activeListId}
            onSelectList={setActiveList}
            onAddList={addContactList}
            onRemoveList={removeContactList}
            label="Address Books"
          />
        </div>
        <button
          type="button"
          onClick={() => setShowNewForm(true)}
          disabled={!canWrite}
          className={`flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors ${!canWrite ? 'opacity-50 cursor-not-allowed' : 'hover:bg-emerald-500'}`}
          title={!canWrite ? 'Subscription required' : undefined}
        >
          <Plus className="h-4 w-4" />
          New Contact
        </button>
      </div>

      {/* Search */}
      <SearchBar />

      {/* New Contact Form */}
      {showNewForm && (
        <ContactForm
          onClose={() => setShowNewForm(false)}
          onSaved={(id) => {
            setShowNewForm(false)
            setSelectedId(id)
          }}
        />
      )}

      {/* Content */}
      {isLoading ? (
        <ContactSkeleton />
      ) : isEmpty ? (
        <ContactsEmptyState onAddContact={canWrite ? () => setShowNewForm(true) : undefined} />
      ) : isEmptySearch ? (
        <SearchEmptyState query={searchQuery} />
      ) : (
        <div className="flex flex-1 gap-4 overflow-hidden">
          {/* Contact list */}
          <div
            className={`flex-1 overflow-y-auto space-y-0.5 md:max-w-xs md:flex-none md:border-r md:border-[rgb(var(--border))] md:pr-4 ${
              selectedContact ? 'hidden md:block' : ''
            }`}
          >
            {filtered.map((contact) => (
              <ContactListItem
                key={contact.id}
                contact={contact}
                isSelected={contact.id === selectedId}
                onSelect={() => setSelectedId(contact.id)}
              />
            ))}
          </div>

          {/* Detail panel */}
          {selectedContact ? (
            <div className="flex-1 overflow-y-auto md:pl-2">
              <ContactDetail
                contact={selectedContact}
                onBack={() => setSelectedId(null)}
                onDeleted={() => setSelectedId(null)}
              />
            </div>
          ) : (
            <div className="hidden flex-1 md:flex">
              <ContactDetailEmptyState />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
