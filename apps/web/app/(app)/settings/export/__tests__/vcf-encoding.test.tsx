import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { toVCard, type Contact } from '@silentsuite/core'
import JSZip from 'jszip'
import ExportPage from '../page'
import ContactImport from '@/app/components/import/ContactImport'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'

// Byte-level regression for exported .vcf files. The serializer emits vCard
// 3.0, whose charset is not implied by the format, so a downloaded file has no
// in-band signal that it is UTF-8. These tests read the actual Blob bytes the
// page hands to the browser (and real JSZip archive bytes) rather than
// inspecting intermediate strings.

const BOM = [0xef, 0xbb, 0xbf]

const mockData = vi.hoisted(() => ({
  contacts: [] as Record<string, unknown>[],
  events: [] as Record<string, unknown>[],
  importContacts: vi.fn(),
}))

function contact(id: string, displayName: string, given: string, family: string) {
  const now = new Date('2026-10-23T00:00:00Z')
  return {
    id,
    uid: `uid-${id}`,
    displayName,
    listId: 'default',
    name: { given, family },
    phones: [],
    emails: [],
    addresses: [],
    organization: '',
    title: '',
    notes: '',
    birthday: null,
    photoUrl: null,
    created_at: now,
    updated_at: now,
  }
}

// Synthetic names covering Latin diacritics, CJK, Vietnamese and a Greek name
// long enough that the serializer must fold within multi-byte UTF-8 text.
const INTERNATIONAL = [
  contact('1', 'Zoë Ångström', 'Zoë', 'Ångström'),
  contact('2', '張偉', '偉', '張'),
  contact('3', 'Đặng Thị Hương', 'Hương', 'Đặng'),
  contact(
    '4',
    'Ελένη Παπαδοπούλου-Χατζηγεωργίου-Αναστασοπούλου',
    'Ελένη',
    'Παπαδοπούλου-Χατζηγεωργίου-Αναστασοπούλου',
  ),
]

const EVENT = {
  id: 'e1',
  uid: 'e1',
  title: 'Meeting',
  calendarId: 'default',
  startDate: new Date('2026-10-23T09:00:00Z'),
  endDate: new Date('2026-10-23T10:00:00Z'),
  allDay: false,
  description: '',
  location: '',
  recurrenceRule: null,
  exceptions: [],
  alarms: [],
  created: new Date('2026-10-23T00:00:00Z'),
  updated: new Date('2026-10-23T00:00:00Z'),
}

vi.mock('@/app/stores/use-toast-store', () => ({
  showErrorToast: vi.fn(),
  showWarningToast: vi.fn(),
}))
vi.mock('@/app/stores/use-task-store', () => ({
  useTaskStore: (selector: (s: { tasks: unknown[] }) => unknown) => selector({ tasks: [] }),
}))
vi.mock('@/app/stores/use-contact-store', () => ({
  useContactStore: (selector: (s: { contacts: unknown[]; importContacts: unknown }) => unknown) =>
    selector({ contacts: mockData.contacts, importContacts: mockData.importContacts }),
}))
vi.mock('@/app/stores/use-calendar-store', () => ({
  useCalendarStore: (selector: (s: { events: unknown[] }) => unknown) =>
    selector({ events: mockData.events }),
}))
vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: (selector: (s: { createCollection: unknown }) => unknown) =>
    selector({ createCollection: vi.fn() }),
}))
vi.mock('@/app/stores/use-calendar-list-store', () => ({
  useCalendarListStore: (selector: (s: { calendars: unknown[] }) => unknown) =>
    selector({ calendars: [] }),
}))
vi.mock('@/app/stores/use-task-list-store', () => ({
  useTaskListStore: (selector: (s: { lists: unknown[] }) => unknown) => selector({ lists: [] }),
}))
vi.mock('@/app/stores/use-contact-list-store', () => ({
  useContactListStore: (selector: (s: { lists: unknown[]; activeListId: string }) => unknown) =>
    selector({
      lists: [{ id: 'default', name: 'My Contacts', color: '#8b5cf6', visible: true }],
      activeListId: 'default',
    }),
}))
vi.mock('@silentsuite/ui', () => ({
  Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}))

vi.stubGlobal('URL', {
  ...globalThis.URL,
  createObjectURL: vi.fn(() => 'blob:mock'),
  revokeObjectURL: vi.fn(),
})

function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

function downloadedBlob(): Blob {
  const calls = vi.mocked(URL.createObjectURL).mock.calls
  return calls[calls.length - 1]![0] as Blob
}

/** Under jsdom, TextEncoder output is a Uint8Array from a different realm than
 * the one JSZip checks with `instanceof`, so real JSZip rejects it. Browsers
 * have a single realm. Copy the identical bytes into this realm before they
 * reach the real JSZip so the archive itself is still built and read for real. */
function realmSafeZipFiles() {
  const original = JSZip.prototype.file
  vi.spyOn(JSZip.prototype, 'file').mockImplementation(function (this: JSZip, ...args: unknown[]) {
    const forwarded = args.map((arg) => (ArrayBuffer.isView(arg) ? Uint8Array.from(arg as Uint8Array) : arg))
    return (original as (...a: unknown[]) => JSZip).apply(this, forwarded)
  } as typeof original)
}

const utf8 = (s: string) => Array.from(new TextEncoder().encode(s))

describe('contacts .vcf export bytes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockData.events = []
    mockData.importContacts.mockReset()
    vi.mocked(URL.createObjectURL).mockImplementation(() => 'blob:mock')
    const originalCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag)
      if (tag === 'a') vi.spyOn(el, 'click').mockImplementation(() => {})
      return el
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes a UTF-8 BOM followed by CRLF-terminated UTF-8 card bytes', async () => {
    mockData.contacts = [contact('1', 'Zoë Ångström', 'Zoë', 'Ångström')]
    render(<ExportPage />)
    fireEvent.click(screen.getByText(/Export Contacts/))

    const blob = downloadedBlob()
    expect(blob.type).toBe('text/vcard')
    const bytes = Array.from(await readBlobBytes(blob))
    const card = toVCard(mockData.contacts[0] as never)
    expect(bytes).toEqual([...BOM, ...utf8(`${card}\r\n`)])
  })

  it('writes the same BOM-prefixed, CRLF-terminated bytes into the ZIP contacts entry', async () => {
    mockData.contacts = [contact('1', 'Zoë Ångström', 'Zoë', 'Ångström')]
    realmSafeZipFiles()
    render(<ExportPage />)
    fireEvent.click(screen.getByText(/Export All Data/))
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())

    const zip = await JSZip.loadAsync(await readBlobBytes(downloadedBlob()))
    const vcf = Array.from(await zip.file('silentsuite-contacts.vcf')!.async('uint8array'))
    const card = toVCard(mockData.contacts[0] as never)
    expect(vcf).toEqual([...BOM, ...utf8(`${card}\r\n`)])

    // Calendar/task entries keep their existing encoding (no BOM added).
    const ics = await zip.file('silentsuite-calendar.ics')!.async('uint8array')
    expect(Array.from(ics.slice(0, 3))).toEqual(utf8('BEG'))
  })

  it('writes one leading BOM and CRLF-terminates every card for multiple international contacts', async () => {
    mockData.contacts = INTERNATIONAL
    render(<ExportPage />)
    fireEvent.click(screen.getByText(/Export Contacts/))

    const bytes = await readBlobBytes(downloadedBlob())
    const cards = INTERNATIONAL.map((c) => toVCard(c as never))
    expect(Array.from(bytes)).toEqual([...BOM, ...utf8(cards.map((card) => `${card}\r\n`).join(''))])
    // The BOM appears exactly once, at the start of the file.
    expect(countBoms(bytes)).toBe(1)
    // The long Greek name is folded by the serializer; folds stay CRLF+space.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    expect(text).toContain('\r\n ')
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
  })

  it('never puts U+FEFF into individual serialized cards', () => {
    for (const c of INTERNATIONAL) {
      const card = toVCard(c as never)
      expect(card).not.toContain('﻿')
      expect(card.startsWith('BEGIN:VCARD')).toBe(true)
    }
  })

  it('writes an empty ZIP contacts entry (no BOM-only file) when there are no contacts', async () => {
    mockData.contacts = []
    mockData.events = [EVENT]
    realmSafeZipFiles()
    render(<ExportPage />)
    fireEvent.click(screen.getByText(/Export All Data/))
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())

    const zip = await JSZip.loadAsync(await readBlobBytes(downloadedBlob()))
    const vcf = await zip.file('silentsuite-contacts.vcf')!.async('uint8array')
    expect(vcf.length).toBe(0)
  })

  it('round-trips the exported file through the real contact importer without a stray U+FEFF', async () => {
    mockData.contacts = INTERNATIONAL
    render(<ExportPage />)
    fireEvent.click(screen.getByText(/Export Contacts/))
    const bytes = await readBlobBytes(downloadedBlob())
    cleanup()

    mockData.importContacts.mockResolvedValue(INTERNATIONAL.length)
    const { container } = renderWithIntl(<ContactImport onImportComplete={vi.fn()} />)
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File([bytes], 'silentsuite-contacts.vcf', { type: 'text/vcard' })] },
    })
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`Import ${INTERNATIONAL.length} contacts`) }))
    await waitFor(() => expect(mockData.importContacts).toHaveBeenCalledTimes(1))

    const imported = mockData.importContacts.mock.calls[0]![0] as Contact[]
    expect(imported.map((c) => c.displayName)).toEqual(INTERNATIONAL.map((c) => c.displayName))
    expect(imported.map((c) => [c.name?.given, c.name?.family])).toEqual(
      INTERNATIONAL.map((c) => [c.name.given, c.name.family]),
    )
    expect(JSON.stringify(imported)).not.toContain('﻿')
  })

  it('imports a file whose text still begins with a literal U+FEFF', async () => {
    // File.text() strips one leading BOM; the second one survives decoding and
    // so exercises the splitter's handling of a literal U+FEFF before BEGIN.
    mockData.importContacts.mockResolvedValue(1)
    const card = toVCard(INTERNATIONAL[0] as never)
    const { container } = renderWithIntl(<ContactImport onImportComplete={vi.fn()} />)
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File([`﻿﻿${card}\r\n`], 'bom.vcf', { type: 'text/vcard' })] },
    })
    fireEvent.click(await screen.findByRole('button', { name: /Import 1 contacts/ }))
    await waitFor(() => expect(mockData.importContacts).toHaveBeenCalledTimes(1))
    const imported = mockData.importContacts.mock.calls[0]![0] as Contact[]
    expect(imported[0]!.displayName).toBe('Zoë Ångström')
  })
})

function countBoms(bytes: Uint8Array): number {
  let count = 0
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] === 0xef && bytes[i + 1] === 0xbb && bytes[i + 2] === 0xbf) count++
  }
  return count
}
