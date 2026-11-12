import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import ReportProblemPage from '../page'
import { formatDiagnostics } from '@/app/lib/problem-report'

const RELAY = 'https://relay.test/v1/reports'
const FULL_SHA = '0123456789abcdef0123456789abcdef01234567'

const state = vi.hoisted(() => ({
  sync: {
    isOnline: true,
    syncStatus: 'synced' as string,
    error: null as string | null,
    lastSyncedAt: null as Date | null,
  },
  etebase: {
    domainLoadState: { calendar: 'loaded', contacts: 'loaded', tasks: 'loaded', notes: 'unknown' } as Record<string, string>,
  },
}))

vi.mock('@/app/stores/use-sync-store', () => ({ useSyncStore: { getState: () => state.sync } }))
vi.mock('@/app/stores/use-etebase-store', () => ({ useEtebaseStore: { getState: () => state.etebase } }))
vi.mock('@/app/lib/self-hosted', () => ({ isSelfHosted: false, isCustomServer: (url?: string) => !!url }))
vi.mock('@/app/lib/config', () => ({
  BILLING_API_URL: 'https://api.silentsuite.io',
  ETEBASE_SERVER_URL: 'https://server.silentsuite.io',
  REPORT_RELAY_URL: 'https://relay.test/v1/reports',
}))
vi.mock('@/app/lib/problem-report', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/lib/problem-report')>()),
  REPORT_SEND_TIMEOUT_MS: 50,
}))

type FetchCall = [string, RequestInit | undefined]
let fetchMock: ReturnType<typeof vi.fn>
let relayResponse: (init: RequestInit | undefined) => Promise<Response>

function identityResponse() {
  return Promise.resolve(new Response(JSON.stringify({ publicSha: FULL_SHA }), { status: 200 }))
}

function relayCalls() {
  return (fetchMock.mock.calls as FetchCall[]).filter(([url]) => url === RELAY)
}

function fillForm() {
  fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'Calendar does not load' } })
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'It spins forever.\r\nSince today.' } })
}

async function previewText() {
  const preview = await screen.findByTestId('report-diagnostics-preview')
  await waitFor(() => expect(preview.textContent).toContain('"app_version"'))
  return preview.textContent!
}

describe('Report a problem page', () => {
  beforeEach(() => {
    state.sync.error = null
    state.sync.syncStatus = 'synced'
    localStorage.clear()
    sessionStorage.clear()
    relayResponse = () => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 201 }))
    fetchMock = vi.fn((url: string, init?: RequestInit) => (url === RELAY ? relayResponse(init) : identityResponse()))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the disclosure, privacy link and retention before anything is sent', async () => {
    renderWithIntl(<ReportProblemPage />)
    await previewText()
    expect(
      screen.getByText(
        "Your report is sent through Cloudflare and delivered by email (via Resend) to the SilentSuite support inbox. It is not end-to-end encrypted and not linked to your account. We delete it 90 days after we've dealt with it; to have it deleted sooner, email support@silentsuite.io.",
        { exact: false },
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', 'https://silentsuite.io/privacy#problem-reports')
  })

  it('makes no relay request while opening, editing, toggling diagnostics or switching kind', async () => {
    renderWithIntl(<ReportProblemPage />)
    await previewText()
    fillForm()
    fireEvent.click(screen.getByLabelText('Include diagnostic info'))
    fireEvent.click(screen.getByLabelText('Include diagnostic info'))
    fireEvent.click(screen.getByLabelText('Feature request'))
    expect(screen.getByLabelText('Include diagnostic info')).not.toBeChecked()
    fireEvent.click(screen.getByLabelText('Problem'))
    expect(screen.getByLabelText('Include diagnostic info')).toBeChecked()
    await previewText()

    expect(relayCalls()).toHaveLength(0)
    // The only request before Send is the same-origin build identity, with no user text.
    for (const [url, init] of fetchMock.mock.calls as FetchCall[]) {
      expect(url).toBe('/api/deployment-identity')
      expect(init?.body).toBeUndefined()
    }
  })

  it('sends no request at all for a feature request without diagnostics until Send', async () => {
    renderWithIntl(<ReportProblemPage />)
    fireEvent.click(screen.getByLabelText('Feature request'))
    fetchMock.mockClear()
    fillForm()
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Thanks, your report was sent.')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(relayCalls()[0]![1]!.body as string)
    expect(body).toEqual({
      schema: 1,
      kind: 'feature',
      surface: 'web',
      summary: 'Calendar does not load',
      description: 'It spins forever.\nSince today.',
    })
  })

  it('sends the frozen diagnostics shown in the preview, byte for byte', async () => {
    renderWithIntl(<ReportProblemPage />)
    const shown = await previewText()
    expect(shown).toContain('"build_sha": "0123456789ab"')

    // Store changes after the preview is shown must not change what is sent.
    act(() => {
      state.sync.error = 'Sync initialization failed'
      state.sync.syncStatus = 'error'
    })
    fillForm()
    fireEvent.change(screen.getByLabelText('Reply email (optional)'), { target: { value: 'me@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Thanks, your report was sent.')).toBeInTheDocument()

    const [[, init]] = relayCalls()
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' } })
    const body = JSON.parse(init!.body as string)
    expect(formatDiagnostics(body.diagnostics)).toBe(shown)
    expect(body.diagnostics.error_codes).toEqual([])
    expect(body.contact_email).toBe('me@example.com')
  })

  it('shows the unknown-outcome message after a timeout and makes exactly one request', async () => {
    relayResponse = (init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    renderWithIntl(<ReportProblemPage />)
    await previewText()
    fillForm()
    const send = screen.getByRole('button', { name: 'Send' })
    fireEvent.click(send)
    fireEvent.click(send)

    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't confirm your report was sent.")
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Email instead' }).getAttribute('href')).toMatch(/^mailto:support@silentsuite\.io\?subject=/)
    expect(screen.getByRole('button', { name: 'Copy' })).toBeEnabled()

    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(relayCalls()).toHaveLength(1)
  })

  it.each([502, 503])('treats a %i relay response as unconfirmed with Email and Copy, without retrying', async (status) => {
    relayResponse = () => Promise.resolve(new Response('{}', { status }))
    renderWithIntl(<ReportProblemPage />)
    await previewText()
    fillForm()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't confirm your report was sent.")
    expect(screen.getByRole('link', { name: 'Email instead' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeEnabled()
    expect(relayCalls()).toHaveLength(1)
  })

  it('omits build_sha when the identity endpoint is unavailable', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      url === RELAY ? relayResponse(init) : Promise.resolve(new Response('{}', { status: 503 })),
    )
    renderWithIntl(<ReportProblemPage />)
    expect(await previewText()).not.toContain('build_sha')
  })
})
