import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ExportPage from '../page'

// Mock stores
vi.mock('@/app/stores/use-task-store', () => ({
  useTaskStore: (selector: (s: { tasks: unknown[] }) => unknown) =>
    selector({
      tasks: [
        {
          id: '1',
          uid: 't1',
          title: 'Test task',
          priority: 'medium',
          completed: false,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    }),
}))

vi.mock('@/app/stores/use-contact-store', () => ({
  useContactStore: (selector: (s: { contacts: unknown[] }) => unknown) =>
    selector({
      contacts: [
        {
          id: '1',
          uid: 'c1',
          displayName: 'Alice',
          name: { given: 'Alice', family: 'Smith' },
          phones: [],
          emails: [],
          addresses: [],
          organization: '',
          title: '',
          notes: '',
          birthday: null,
          photoUrl: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    }),
}))

vi.mock('@/app/stores/use-calendar-store', () => ({
  useCalendarStore: (selector: (s: { events: unknown[] }) => unknown) =>
    selector({
      events: [
        {
          id: '1',
          uid: 'e1',
          title: 'Meeting',
          startDate: new Date(),
          endDate: new Date(),
          allDay: false,
          description: '',
          location: '',
          recurrenceRule: null,
          exceptions: [],
          alarms: [],
          created: new Date(),
          updated: new Date(),
        },
      ],
    }),
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
}))

// Mock jszip
vi.mock('jszip', () => {
  const mockFile = vi.fn()
  const mockGenerateAsync = vi
    .fn()
    .mockResolvedValue(new Blob(['zip'], { type: 'application/zip' }))
  return {
    default: vi.fn(() => ({
      file: mockFile,
      generateAsync: mockGenerateAsync,
    })),
  }
})

// Mock URL.createObjectURL and URL.revokeObjectURL
vi.stubGlobal('URL', {
  ...globalThis.URL,
  createObjectURL: vi.fn(() => 'blob:mock'),
  revokeObjectURL: vi.fn(),
})

describe('ExportPage', () => {
  let clickedLink: HTMLAnchorElement | null = null

  beforeEach(() => {
    clickedLink = null
    vi.clearAllMocks()
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
})
