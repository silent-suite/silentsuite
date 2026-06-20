import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { toVEvent, toVTodo, toVCard } from '@silentsuite/core'
import { showErrorToast, showWarningToast } from '@/app/stores/use-toast-store'
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
vi.mock('@silentsuite/core', () => ({
  toVEvent: vi.fn(() => 'BEGIN:VEVENT\r\nSUMMARY:Meeting\r\nEND:VEVENT'),
  toVTodo: vi.fn(() => 'BEGIN:VTODO\r\nSUMMARY:Test task\r\nEND:VTODO'),
  toVCard: vi.fn(() => 'BEGIN:VCARD\r\nFN:Alice\r\nEND:VCARD'),
}))

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
