import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useDomainSnapshotStore } from '@/app/stores/use-domain-snapshot-store'
import { bumpAccountEpoch, getAccountEpoch } from '@/app/lib/account-epoch'
import { act, render, screen, fireEvent } from '@testing-library/react'
import { toVEvent, toVTodo, toVCard } from '@silentsuite/core'
import { showErrorToast, showWarningToast } from '@/app/stores/use-toast-store'
import JSZip from 'jszip'
import ExportPage from '../page'

// Mutable mock data so individual tests can configure collections + items.
// `vi.hoisted` runs before the module mocks below are evaluated, which is
// required because `vi.mock` factories are hoisted above the imports.
const mockData = vi.hoisted(() => {
  const now = new Date()
  return {
    events: [
      {
        id: '1',
        uid: 'e1',
        title: 'Meeting',
        calendarId: 'default',
        startDate: now,
        endDate: now,
        allDay: false,
        description: '',
        location: '',
        recurrenceRule: null,
        exceptions: [],
        alarms: [],
        created: now,
        updated: now,
      },
    ],
    tasks: [
      {
        id: '1',
        uid: 't1',
        title: 'Test task',
        listId: 'default',
        priority: 'medium',
        completed: false,
        created_at: now,
        updated_at: now,
      },
    ],
    contacts: [
      {
        id: '1',
        uid: 'c1',
        displayName: 'Alice',
        listId: 'default',
        name: { given: 'Alice', family: 'Smith' },
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
      },
    ],
    calendars: [
      { id: 'default', name: 'Personal', color: '#10b981', visible: true },
    ],
    taskLists: [
      { id: 'default', name: 'My Tasks', color: '#3b82f6', visible: true },
    ],
    contactLists: [
      { id: 'default', name: 'My Contacts', color: '#8b5cf6', visible: true },
    ],
  }
})

vi.mock('@/app/stores/use-toast-store', () => ({
  showErrorToast: vi.fn(),
  showWarningToast: vi.fn(),
}))

// Mock item stores
vi.mock('@/app/stores/use-task-store', () => ({
  useTaskStore: (selector: (s: { tasks: unknown[] }) => unknown) =>
    selector({ tasks: mockData.tasks }),
}))

vi.mock('@/app/stores/use-contact-store', () => ({
  useContactStore: (selector: (s: { contacts: unknown[] }) => unknown) =>
    selector({ contacts: mockData.contacts }),
}))

vi.mock('@/app/stores/use-calendar-store', () => ({
  useCalendarStore: (selector: (s: { events: unknown[] }) => unknown) =>
    selector({ events: mockData.events }),
}))

// Mock collection-list stores
vi.mock('@/app/stores/use-calendar-list-store', () => ({
  useCalendarListStore: (selector: (s: { calendars: unknown[] }) => unknown) =>
    selector({ calendars: mockData.calendars }),
}))

vi.mock('@/app/stores/use-task-list-store', () => ({
  useTaskListStore: (selector: (s: { lists: unknown[] }) => unknown) =>
    selector({ lists: mockData.taskLists }),
}))

vi.mock('@/app/stores/use-contact-list-store', () => ({
  useContactListStore: (selector: (s: { lists: unknown[] }) => unknown) =>
    selector({ lists: mockData.contactLists }),
}))

// Mock @silentsuite/core serializers
vi.mock('@silentsuite/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@silentsuite/core')>()
  return {
    ...actual,
    toVEvent: vi.fn(() => 'BEGIN:VEVENT\r\nSUMMARY:Meeting\r\nEND:VEVENT'),
    toVTodo: vi.fn(() => 'BEGIN:VTODO\r\nSUMMARY:Test task\r\nEND:VTODO'),
    toVCard: vi.fn(actual.toVCard),
  }
})

// Mock @silentsuite/ui
vi.mock('@silentsuite/ui', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...props
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
    variant?: string
  }) => (
    <button onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  ),
}))

// Mock lucide-react
vi.mock('lucide-react', () => ({
  Download: ({ className }: { className?: string }) => (
    <svg data-testid="download-icon" className={className} />
  ),
  Loader2: ({ className }: { className?: string }) => (
    <svg data-testid="loader-icon" className={className} />
  ),
}))

// Mock jszip
vi.mock('jszip', () => {
  const mockFile = vi.fn()
  const mockGenerateAsync = vi
    .fn()
    .mockResolvedValue(new Blob(['zip'], { type: 'application/zip' }))
  return {
    default: vi.fn(function MockJSZip() {
      return {
        file: mockFile,
        generateAsync: mockGenerateAsync,
      }
    }),
  }
})

// ── WEB-07 fixture addition: per-domain load state ──
// Mirrors the real zustand hook: callable with a selector and exposing
// getState(). State keys and values are the real DomainLoadState ones from
// use-etebase-store. Default: every exported domain loaded, so the existing
// tests above see a complete view. Only the WEB-07 block below changes it.
const etebaseMock = vi.hoisted(() => {
  type DomainStatus = 'unknown' | 'loaded' | 'failed'
  const loadedState = () => ({
    isInitialized: true,
    restoreBlocked: false,
    domainLoadState: {
      calendar: 'loaded',
      tasks: 'loaded',
      contacts: 'loaded',
      notes: 'loaded',
      preferences: 'unknown',
    } as Record<'calendar' | 'tasks' | 'contacts' | 'notes' | 'preferences', DomainStatus>,
  })
  return { loadedState, state: loadedState() }
})

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: Object.assign(
    (selector: (s: typeof etebaseMock.state) => unknown) => selector(etebaseMock.state),
    { getState: () => etebaseMock.state },
  ),
}))

// Default for every test: each exported domain's loaded server snapshot has
// reached its UI store for the current account (real store, real epoch).
beforeEach(() => {
  const epoch = getAccountEpoch()
  useDomainSnapshotStore.setState({ appliedEpoch: { calendar: epoch, tasks: epoch, contacts: epoch } })
})

// Mock URL.createObjectURL and URL.revokeObjectURL
vi.stubGlobal('URL', {
  ...globalThis.URL,
  createObjectURL: vi.fn(() => 'blob:mock'),
  revokeObjectURL: vi.fn(),
})

/** Reset the shared mock data back to the single-collection defaults. */
function resetMockData() {
  const now = new Date()
  mockData.events = [
    {
      id: '1',
      uid: 'e1',
      title: 'Meeting',
      calendarId: 'default',
      startDate: now,
      endDate: now,
      allDay: false,
      description: '',
      location: '',
      recurrenceRule: null,
      exceptions: [],
      alarms: [],
      created: now,
      updated: now,
    },
  ]
  mockData.tasks = [
    {
      id: '1',
      uid: 't1',
      title: 'Test task',
      listId: 'default',
      priority: 'medium',
      completed: false,
      created_at: now,
      updated_at: now,
    },
  ]
  mockData.contacts = [
    {
      id: '1',
      uid: 'c1',
      displayName: 'Alice',
      listId: 'default',
      name: { given: 'Alice', family: 'Smith' },
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
    },
  ]
  mockData.calendars = [
    { id: 'default', name: 'Personal', color: '#10b981', visible: true },
  ]
  mockData.taskLists = [
    { id: 'default', name: 'My Tasks', color: '#3b82f6', visible: true },
  ]
  mockData.contactLists = [
    { id: 'default', name: 'My Contacts', color: '#8b5cf6', visible: true },
  ]
}

describe('ExportPage', () => {
  let clickedLink: HTMLAnchorElement | null = null

  beforeEach(() => {
    clickedLink = null
    resetMockData()
    vi.restoreAllMocks()
    vi.clearAllMocks()
    // Reset the URL stubs each test. An earlier case reassigns
    // URL.createObjectURL's implementation; without a per-test reset that can
    // leak a self-referential implementation that recurses (RangeError) into
    // later tests.
    ;(URL.createObjectURL as ReturnType<typeof vi.fn>).mockImplementation(() => 'blob:mock')
    ;(URL.revokeObjectURL as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    // Mock document.createElement to capture the download link
    const originalCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag)
      if (tag === 'a') {
        clickedLink = el as HTMLAnchorElement
        vi.spyOn(el, 'click').mockImplementation(() => {})
      }
      return el
    })
  })

  it('renders all export buttons', () => {
    render(<ExportPage />)
    expect(screen.getByText(/Export Calendar/)).toBeInTheDocument()
    expect(screen.getByText(/Export Tasks/)).toBeInTheDocument()
    expect(screen.getByText(/Export Contacts/)).toBeInTheDocument()
    expect(screen.getByText(/Export All Data/)).toBeInTheDocument()
  })

  it('renders heading and description', () => {
    render(<ExportPage />)
    expect(screen.getByText('Export Data')).toBeInTheDocument()
    expect(screen.getByText(/Download your data in standard formats/)).toBeInTheDocument()
  })

  it('renders a collection selector for each type', () => {
    render(<ExportPage />)
    expect(screen.getByLabelText('Calendar collection')).toBeInTheDocument()
    expect(screen.getByLabelText('Task list collection')).toBeInTheDocument()
    expect(screen.getByLabelText('Address book collection')).toBeInTheDocument()
  })

  it('renders the "All" option plus each collection in the selectors', () => {
    mockData.calendars = [
      { id: 'default', name: 'Personal', color: '#10b981', visible: true },
      { id: 'work', name: 'Work', color: '#3b82f6', visible: true },
    ]
    const { container } = render(<ExportPage />)
    const select = screen.getByLabelText('Calendar collection') as HTMLSelectElement
    const options = Array.from(select.options).map((o) => o.value)
    expect(options).toEqual(['all', 'default', 'work'])
    // sanity: the rendered DOM contains the option text
    expect(container.textContent).toContain('All calendars')
    expect(container.textContent).toContain('Work')
  })

  it('displays item counts next to export buttons', () => {
    render(<ExportPage />)
    expect(screen.getByText(/1 event/)).toBeInTheDocument()
    expect(screen.getByText(/1 task/)).toBeInTheDocument()
    expect(screen.getByText(/1 contact/)).toBeInTheDocument()
  })

  it('renders download icons', () => {
    render(<ExportPage />)
    const icons = screen.getAllByTestId('download-icon')
    expect(icons.length).toBe(4)
  })

  it('triggers .ics download on Export Calendar click', () => {
    render(<ExportPage />)
    fireEvent.click(screen.getByText(/Export Calendar/))

    expect(URL.createObjectURL).toHaveBeenCalled()
    expect(clickedLink).not.toBeNull()
    expect(clickedLink!.download).toBe('silentsuite-calendar.ics')
  })

  it('triggers .ics download on Export Tasks click', () => {
    render(<ExportPage />)
    fireEvent.click(screen.getByText(/Export Tasks/))

    expect(URL.createObjectURL).toHaveBeenCalled()
    expect(clickedLink).not.toBeNull()
    expect(clickedLink!.download).toBe('silentsuite-tasks.ics')
  })

  it('triggers .vcf download on Export Contacts click', () => {
    render(<ExportPage />)
    fireEvent.click(screen.getByText(/Export Contacts/))

    expect(URL.createObjectURL).toHaveBeenCalled()
    expect(clickedLink).not.toBeNull()
    expect(clickedLink!.download).toBe('silentsuite-contacts.vcf')
  })

  it('triggers .zip download on Export All Data click', async () => {
    render(<ExportPage />)
    fireEvent.click(screen.getByText(/Export All Data/))

    // Wait for async zip generation
    await vi.waitFor(() => {
      expect(URL.createObjectURL).toHaveBeenCalled()
    })

    expect(clickedLink).not.toBeNull()
    expect(clickedLink!.download).toBe('silentsuite-export.zip')
  })

  it('verifies calendar export has text/calendar MIME type', () => {
    render(<ExportPage />)
    fireEvent.click(screen.getByText(/Export Calendar/))

    const blobCall = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Blob
    expect(blobCall.type).toBe('text/calendar')
  })

  it('verifies contacts export has text/vcard MIME type', () => {
    render(<ExportPage />)
    fireEvent.click(screen.getByText(/Export Contacts/))

    const blobCall = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Blob
    expect(blobCall.type).toBe('text/vcard')
  })

  it('keeps unsupported contact properties in the downloaded VCF and ZIP entry bytes (#865)', async () => {
    const extras = ['X-TESTA:testA', 'X-TestB:testB', 'X-testC:testC', 'X-testd:testD']
    Object.assign(mockData.contacts[0]!, { unknownProperties: extras })
    const readBytes = (blob: Blob) => new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(blob)
    })
    const customLinesOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes.slice(3)).split('\r\n').filter((line) => /^X-test/i.test(line))

    render(<ExportPage />)
    fireEvent.click(screen.getByText(/Export Contacts/))
    const vcfBytes = await readBytes((URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob)
    expect([...vcfBytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(customLinesOf(vcfBytes)).toEqual(extras)

    fireEvent.click(screen.getByText(/Export All Data/))
    const zip = vi.mocked(JSZip).mock.results.at(-1)!.value as { file: ReturnType<typeof vi.fn> }
    await vi.waitFor(() => expect(zip.file).toHaveBeenCalledWith('silentsuite-contacts.vcf', expect.anything()))
    const entry = zip.file.mock.calls.find((call) => call[0] === 'silentsuite-contacts.vcf')![1] as Uint8Array
    expect([...entry.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(customLinesOf(entry)).toEqual(extras)
  })

  it('exports favorite contacts through the canonical contact serializer', () => {
    mockData.contacts[0]!.favorite = true
    render(<ExportPage />)
    fireEvent.click(screen.getByText(/Export Contacts/))
    expect(toVCard).toHaveBeenCalledWith(expect.objectContaining({ favorite: true }))
    expect(vi.mocked(toVCard).mock.results[0]!.value).toContain('X-SILENTSUITE-FAVORITE:1')
  })

  it('skips events that fail to serialize and shows a warning toast', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(toVEvent).mockImplementationOnce(() => {
      throw new Error('boom — PRIVATE_EVENT_TITLE')
    })

    render(<ExportPage />)
    fireEvent.click(screen.getByText(/Export Calendar/))

    expect(URL.createObjectURL).toHaveBeenCalled()
    expect(clickedLink).not.toBeNull()
    expect(clickedLink!.download).toBe('silentsuite-calendar.ics')
    expect(showWarningToast).toHaveBeenCalledWith(
      expect.stringContaining('1 event'),
    )
    expect(showWarningToast).not.toHaveBeenCalledWith(
      expect.stringContaining('browser console'),
    )
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('Meeting')
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('PRIVATE_EVENT_TITLE')
    warnSpy.mockRestore()
  })

  it('shows a safe error toast when the download path fails', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Simulate a real-world failure mode: blob URL creation blocked by a
    // privacy-hardened browser context. Fires after `serializeAll` succeeds,
    // exercising the outer try/catch in `exportCalendar`.
    const originalCreateObjectURL = URL.createObjectURL
    ;(URL.createObjectURL as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => {
        throw new Error('PRIVATE_DOWNLOAD_DETAIL')
      },
    )

    render(<ExportPage />)
    fireEvent.click(screen.getByText(/Export Calendar/))

    expect(showErrorToast).toHaveBeenCalledWith('Calendar export failed. Please try again.')
    expect(showErrorToast).not.toHaveBeenCalledWith(expect.stringContaining('PRIVATE_DOWNLOAD_DETAIL'))
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('PRIVATE_DOWNLOAD_DETAIL')
    errorSpy.mockRestore()

    // restore the spy for downstream tests in this describe block
    ;(URL.createObjectURL as ReturnType<typeof vi.fn>).mockImplementation(
      originalCreateObjectURL as () => string,
    )
  })

  // ── Per-collection selection (issue #299) ──

  it('updates the calendar count when a specific calendar is selected', () => {
    mockData.calendars = [
      { id: 'default', name: 'Personal', color: '#10b981', visible: true },
      { id: 'work', name: 'Work', color: '#3b82f6', visible: true },
    ]
    mockData.events = [
      { ...mockData.events[0]!, id: '1', calendarId: 'default' },
      { ...mockData.events[0]!, id: '2', title: 'Standup', calendarId: 'work' },
    ]

    render(<ExportPage />)
    // "All calendars" aggregates both events
    expect(screen.getByText(/2 events/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Calendar collection'), {
      target: { value: 'work' },
    })
    expect(screen.getByText(/1 event/)).toBeInTheDocument()
  })

  it('filters events to the selected calendar and serializes only those', () => {
    mockData.calendars = [
      { id: 'default', name: 'Personal', color: '#10b981', visible: true },
      { id: 'work', name: 'Work', color: '#3b82f6', visible: true },
    ]
    const workEvent = { ...mockData.events[0]!, id: '2', title: 'Standup', calendarId: 'work' }
    mockData.events = [
      { ...mockData.events[0]!, id: '1', calendarId: 'default' },
      workEvent,
    ]

    render(<ExportPage />)
    fireEvent.change(screen.getByLabelText('Calendar collection'), {
      target: { value: 'work' },
    })
    fireEvent.click(screen.getByText(/Export Calendar/))

    // Only the work event should have been serialized
    expect(vi.mocked(toVEvent)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toVEvent)).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }))
    expect(clickedLink).not.toBeNull()
    expect(clickedLink!.download).toBe('silentsuite-calendar-work.ics')
  })

  it('filters tasks to the selected task list', () => {
    mockData.taskLists = [
      { id: 'default', name: 'My Tasks', color: '#3b82f6', visible: true },
      { id: 'groceries', name: 'Groceries', color: '#10b981', visible: true },
    ]
    const groceryTask = { ...mockData.tasks[0]!, id: '2', title: 'Buy milk', listId: 'groceries' }
    mockData.tasks = [
      { ...mockData.tasks[0]!, id: '1', listId: 'default' },
      groceryTask,
    ]

    render(<ExportPage />)
    fireEvent.change(screen.getByLabelText('Task list collection'), {
      target: { value: 'groceries' },
    })
    fireEvent.click(screen.getByText(/Export Tasks/))

    expect(vi.mocked(toVTodo)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toVTodo)).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }))
    expect(clickedLink).not.toBeNull()
    expect(clickedLink!.download).toBe('silentsuite-tasks-groceries.ics')
  })

  it('filters contacts to the selected address book', () => {
    mockData.contactLists = [
      { id: 'default', name: 'My Contacts', color: '#8b5cf6', visible: true },
      { id: 'family', name: 'Family', color: '#10b981', visible: true },
    ]
    const familyContact = { ...mockData.contacts[0]!, id: '2', displayName: 'Bob', listId: 'family' }
    mockData.contacts = [
      { ...mockData.contacts[0]!, id: '1', listId: 'default' },
      familyContact,
    ]

    render(<ExportPage />)
    fireEvent.change(screen.getByLabelText('Address book collection'), {
      target: { value: 'family' },
    })
    fireEvent.click(screen.getByText(/Export Contacts/))

    expect(vi.mocked(toVCard)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toVCard)).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }))
    expect(clickedLink).not.toBeNull()
    expect(clickedLink!.download).toBe('silentsuite-contacts-family.vcf')
  })

  it('treats items with a missing collection id as belonging to the default collection', () => {
    mockData.calendars = [
      { id: 'default', name: 'Personal', color: '#10b981', visible: true },
      { id: 'work', name: 'Work', color: '#3b82f6', visible: true },
    ]
    // An event with no calendarId should map to 'default' and be filtered out
    // when the 'work' calendar is selected.
    const legacyEvent = { ...mockData.events[0]!, id: '1', calendarId: undefined }
    const workEvent = { ...mockData.events[0]!, id: '2', title: 'Standup', calendarId: 'work' }
    mockData.events = [legacyEvent, workEvent] as unknown as typeof mockData.events

    render(<ExportPage />)
    fireEvent.change(screen.getByLabelText('Calendar collection'), {
      target: { value: 'work' },
    })
    fireEvent.click(screen.getByText(/Export Calendar/))

    expect(vi.mocked(toVEvent)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toVEvent)).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }))
  })

  it('sanitizes the collection name in the export filename', () => {
    mockData.calendars = [
      { id: 'default', name: 'Personal', color: '#10b981', visible: true },
      { id: 'wt', name: 'Work & Travel!!', color: '#3b82f6', visible: true },
    ]
    mockData.events = [
      { ...mockData.events[0]!, id: '1', calendarId: 'wt' },
    ]

    render(<ExportPage />)
    fireEvent.change(screen.getByLabelText('Calendar collection'), {
      target: { value: 'wt' },
    })
    fireEvent.click(screen.getByText(/Export Calendar/))

    expect(clickedLink).not.toBeNull()
    expect(clickedLink!.download).toBe('silentsuite-calendar-work-travel.ics')
  })

  it('disables the per-type export button when the selected collection has no items', () => {
    mockData.calendars = [
      { id: 'default', name: 'Personal', color: '#10b981', visible: true },
      { id: 'empty', name: 'Empty', color: '#3b82f6', visible: true },
    ]
    mockData.events = [
      { ...mockData.events[0]!, id: '1', calendarId: 'default' },
    ]

    render(<ExportPage />)
    // Initially (All calendars) the button is enabled
    expect(screen.getByText(/Export Calendar/).closest('button')!).not.toBeDisabled()

    fireEvent.change(screen.getByLabelText('Calendar collection'), {
      target: { value: 'empty' },
    })
    // Count drops to zero and the button is disabled
    expect(screen.getByText(/0 events/)).toBeInTheDocument()
    expect(screen.getByText(/Export Calendar/).closest('button')!).toBeDisabled()
  })

  it('keeps the all-data ZIP export independent of the per-type selection', async () => {
    mockData.calendars = [
      { id: 'default', name: 'Personal', color: '#10b981', visible: true },
      { id: 'work', name: 'Work', color: '#3b82f6', visible: true },
    ]
    mockData.events = [
      { ...mockData.events[0]!, id: '1', calendarId: 'default' },
      { ...mockData.events[0]!, id: '2', title: 'Standup', calendarId: 'work' },
    ]

    render(<ExportPage />)
    // Narrow the calendar selection — the ZIP should still include everything.
    fireEvent.change(screen.getByLabelText('Calendar collection'), {
      target: { value: 'work' },
    })
    fireEvent.click(screen.getByText(/Export All Data/))

    await vi.waitFor(() => {
      expect(URL.createObjectURL).toHaveBeenCalled()
    })

    // Both events were serialized for the ZIP, regardless of the selection
    expect(vi.mocked(toVEvent)).toHaveBeenCalledTimes(2)
    expect(clickedLink).not.toBeNull()
    expect(clickedLink!.download).toBe('silentsuite-export.zip')
  })
})

// ── Export completeness (WEB-07) ──
// An export may only include a domain whose server view has fully loaded
// (domainLoadState === 'loaded'). 'failed' and 'unknown' domains are refused
// both by the disabled button and inside the click handler, with a visible
// reason. Notes and preferences are not exported and do not gate anything.
// 'loaded' means the last full enumeration in this session succeeded; it is
// not proof of every historical server item.

describe('ExportPage export completeness (WEB-07)', () => {
  let downloads: HTMLAnchorElement[] = []

  const button = (name: RegExp) => screen.getByText(name).closest('button')!
  const downloaded = () => downloads.map((a) => a.download)
  const statusText = () =>
    screen.queryAllByRole('status').map((el) => el.textContent ?? '').join(' ')
  const refusalToasts = () =>
    vi.mocked(showWarningToast).mock.calls.length + vi.mocked(showErrorToast).mock.calls.length

  beforeEach(() => {
    downloads = []
    resetMockData()
    etebaseMock.state = etebaseMock.loadedState()
    // Same per-test reset as the ExportPage block above.
    vi.restoreAllMocks()
    vi.clearAllMocks()
    ;(URL.createObjectURL as ReturnType<typeof vi.fn>).mockImplementation(() => 'blob:mock')
    ;(URL.revokeObjectURL as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const originalCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag)
      if (tag === 'a') {
        downloads.push(el as HTMLAnchorElement)
        vi.spyOn(el, 'click').mockImplementation(() => {})
      }
      return el
    })
  })

  it('disables and refuses the calendar export while the calendar domain failed to load', () => {
    etebaseMock.state.domainLoadState.calendar = 'failed'
    render(<ExportPage />)

    expect(button(/Export Calendar/)).toBeDisabled()
    fireEvent.click(button(/Export Calendar/))
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(statusText()).toMatch(/calendar/i)
  })

  it('refuses a per-type export in the click handler when the domain is no longer loaded', () => {
    render(<ExportPage />)
    expect(button(/Export Tasks/)).not.toBeDisabled()

    // The load state changes after render and before the click.
    etebaseMock.state.domainLoadState.tasks = 'failed'
    fireEvent.click(button(/Export Tasks/))

    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(downloaded()).toEqual([])
    expect(refusalToasts()).toBeGreaterThan(0)
  })

  it.each([
    ['calendar', /calendar/i],
    ['tasks', /task/i],
    ['contacts', /contact/i],
  ] as const)('disables and refuses the all-data ZIP while %s failed to load', (domain, label) => {
    etebaseMock.state.domainLoadState[domain] = 'failed'
    render(<ExportPage />)

    expect(button(/Export All Data/)).toBeDisabled()
    fireEvent.click(button(/Export All Data/))
    expect(vi.mocked(JSZip)).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(statusText()).toMatch(label)
  })

  it('refuses the all-data ZIP in the click handler when a domain is no longer loaded', async () => {
    render(<ExportPage />)
    expect(button(/Export All Data/)).not.toBeDisabled()

    etebaseMock.state.domainLoadState.contacts = 'failed'
    fireEvent.click(button(/Export All Data/))

    // The current handler builds the archive synchronously before its first await.
    expect(vi.mocked(JSZip)).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(refusalToasts()).toBeGreaterThan(0)
  })

  it.each([
    ['while initialization is running', false],
    ['after initialization ended without loading it', true],
  ])('treats an unknown calendar domain as not exportable %s', (_when, isInitialized) => {
    etebaseMock.state.isInitialized = isInitialized
    etebaseMock.state.domainLoadState.calendar = 'unknown'
    render(<ExportPage />)

    expect(button(/Export Calendar/)).toBeDisabled()
    expect(button(/Export All Data/)).toBeDisabled()
    expect(statusText()).toMatch(/calendar/i)
  })

  it('re-enables export once a failed domain loads, without a reload', () => {
    etebaseMock.state.domainLoadState.calendar = 'failed'
    const { rerender } = render(<ExportPage />)
    expect(button(/Export Calendar/)).toBeDisabled()

    etebaseMock.state.domainLoadState.calendar = 'loaded'
    rerender(<ExportPage />)

    expect(button(/Export Calendar/)).not.toBeDisabled()
    fireEvent.click(button(/Export Calendar/))
    expect(downloaded()).toEqual(['silentsuite-calendar.ics'])
    expect(statusText()).not.toMatch(/calendar/i)
  })

  it('control: keeps exports of loaded domains available when another domain failed', () => {
    etebaseMock.state.domainLoadState.calendar = 'failed'
    render(<ExportPage />)

    expect(button(/Export Tasks/)).not.toBeDisabled()
    expect(button(/Export Contacts/)).not.toBeDisabled()
    fireEvent.click(button(/Export Tasks/))
    fireEvent.click(button(/Export Contacts/))
    expect(downloaded()).toEqual(['silentsuite-tasks.ics', 'silentsuite-contacts.vcf'])
  })

  it('control: Notes and preferences load state does not affect calendar, task or contact exports', async () => {
    etebaseMock.state.domainLoadState.notes = 'failed'
    etebaseMock.state.domainLoadState.preferences = 'unknown'
    render(<ExportPage />)

    for (const name of [/Export Calendar/, /Export Tasks/, /Export Contacts/, /Export All Data/]) {
      expect(button(name)).not.toBeDisabled()
    }
    expect(statusText()).toBe('')
    fireEvent.click(button(/Export All Data/))
    await vi.waitFor(() => expect(downloaded()).toContain('silentsuite-export.zip'))
  })

  it('control: a loaded domain with no items is exported as an empty calendar in the all-data ZIP', async () => {
    mockData.events = []
    render(<ExportPage />)

    expect(button(/Export Calendar/)).toBeDisabled()
    expect(button(/Export All Data/)).not.toBeDisabled()
    fireEvent.click(button(/Export All Data/))
    await vi.waitFor(() => expect(downloaded()).toContain('silentsuite-export.zip'))

    const zip = vi.mocked(JSZip).mock.results.at(-1)!.value as { file: ReturnType<typeof vi.fn> }
    const entry = zip.file.mock.calls.find((call) => call[0] === 'silentsuite-calendar.ics')![1] as Uint8Array
    expect(new TextDecoder().decode(entry)).toBe(
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SilentSuite//EN\r\nEND:VCALENDAR',
    )
  })
})

// ── WEB-07 review follow-up: loaded on the server, not yet in the store ──
// domainLoadState turns 'loaded' before the decrypted items reach the task,
// contact and calendar stores (initial decryption, or Retry while another
// domain is still refreshing). Until then the page must treat the domain as
// still loading, or it would export cached or empty arrays.

describe('ExportPage waits for the loaded snapshot to reach the store (WEB-07)', () => {
  let downloads: HTMLAnchorElement[] = []
  const button = (name: RegExp) => screen.getByText(name).closest('button')!
  const statusText = () => screen.queryAllByRole('status').map((el) => el.textContent ?? '').join(' ')

  beforeEach(() => {
    downloads = []
    resetMockData()
    etebaseMock.state = etebaseMock.loadedState()
    vi.restoreAllMocks()
    vi.clearAllMocks()
    ;(URL.createObjectURL as ReturnType<typeof vi.fn>).mockImplementation(() => 'blob:mock')
    ;(URL.revokeObjectURL as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const originalCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag)
      if (tag === 'a') {
        downloads.push(el as HTMLAnchorElement)
        vi.spyOn(el, 'click').mockImplementation(() => {})
      }
      return el
    })
  })

  const unapply = (domain: 'calendar' | 'tasks' | 'contacts') => {
    const { [domain]: _dropped, ...rest } = useDomainSnapshotStore.getState().appliedEpoch
    useDomainSnapshotStore.setState({ appliedEpoch: rest })
  }

  it('disables a loaded domain whose snapshot has not reached its store, and says it is still loading', () => {
    unapply('tasks')
    render(<ExportPage />)

    expect(button(/Export Tasks/)).toBeDisabled()
    expect(button(/Export All/)).toBeDisabled()
    expect(button(/Export Calendar/)).not.toBeDisabled()
    expect(statusText()).toMatch(/Tasks is still loading/)
  })

  it('refuses in the click handler when the snapshot has not reached the store', () => {
    render(<ExportPage />)
    expect(button(/Export Contacts/)).not.toBeDisabled()

    unapply('contacts')
    fireEvent.click(button(/Export Contacts/))

    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(downloads).toEqual([])
    expect(vi.mocked(showWarningToast)).toHaveBeenCalled()
  })

  it('refuses the ZIP in the click handler when any snapshot has not reached its store', () => {
    render(<ExportPage />)
    unapply('calendar')
    fireEvent.click(button(/Export All/))

    expect(vi.mocked(JSZip)).not.toHaveBeenCalled()
    expect(downloads).toEqual([])
  })

  it('enables the export once the snapshot is marked for the current account', () => {
    unapply('tasks')
    render(<ExportPage />)
    expect(button(/Export Tasks/)).toBeDisabled()

    act(() => useDomainSnapshotStore.getState().markApplied('tasks', getAccountEpoch()))

    expect(button(/Export Tasks/)).not.toBeDisabled()
  })

  it('does not trust a mark from a previous account', () => {
    bumpAccountEpoch()
    render(<ExportPage />)

    expect(button(/Export Calendar/)).toBeDisabled()
    expect(button(/Export Tasks/)).toBeDisabled()
    expect(button(/Export Contacts/)).toBeDisabled()
  })
})
