import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const config = vi.hoisted(() => ({ GOOGLE_IMPORT_CLIENT_ID: '' }))
vi.mock('@/app/lib/config', () => config)

const importer = vi.hoisted(() => ({
  evaluated: vi.fn(),
  loadGoogleCalendars: vi.fn(),
  loadGoogleContacts: vi.fn(),
  cancelGoogleImport: vi.fn(),
}))
vi.mock('@/app/lib/google-import/importer', () => {
  importer.evaluated()
  return importer
})

import GoogleImportButton from '../GoogleImportButton'

describe('Import from Google button', () => {
  const popup = { close: vi.fn(), closed: false }
  beforeEach(() => {
    config.GOOGLE_IMPORT_CLIENT_ID = 'client-1.apps.googleusercontent.com'
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    importer.loadGoogleCalendars.mockReset()
    importer.cancelGoogleImport.mockReset()
  })
  afterEach(() => vi.restoreAllMocks())

  it('is hidden when no Google client ID is configured', () => {
    config.GOOGLE_IMPORT_CLIENT_ID = ''
    const { container } = render(<GoogleImportButton kind="calendar" onLoaded={vi.fn()} onError={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says no access is kept and links to where the Google permission is removed', () => {
    render(<GoogleImportButton kind="contacts" onLoaded={vi.fn()} onError={vi.fn()} />)
    expect(screen.getByText(/After the import, SilentSuite keeps no access to your Google account\./)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'third-party connections' })
    expect(link).toHaveAttribute('href', 'https://myaccount.google.com/connections')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('loads the importer only when clicked, opening the popup inside the click', async () => {
    const onLoaded = vi.fn()
    const result = { calendars: [], unreadable: 0 }
    importer.loadGoogleCalendars.mockResolvedValue(result)
    render(<GoogleImportButton kind="calendar" onLoaded={onLoaded} onError={vi.fn()} />)
    expect(importer.evaluated).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Import from Google' }))
    expect(window.open).toHaveBeenCalledWith('about:blank', 'silentsuite-google-import', 'popup,width=520,height=680')
    await waitFor(() => expect(onLoaded).toHaveBeenCalledWith(result))
    expect(importer.evaluated).toHaveBeenCalledTimes(1)
    expect(importer.loadGoogleCalendars).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'client-1.apps.googleusercontent.com', popup }))
  })

  it('cancel and leaving the page end the run and drop the token', async () => {
    importer.loadGoogleCalendars.mockReturnValue(new Promise(() => undefined))
    const onError = vi.fn()
    const view = render(<GoogleImportButton kind="calendar" onLoaded={vi.fn()} onError={onError} />)
    fireEvent.click(screen.getByRole('button', { name: 'Import from Google' }))
    await waitFor(() => expect(importer.loadGoogleCalendars).toHaveBeenCalled())
    const signal = importer.loadGoogleCalendars.mock.calls[0]![0].signal as AbortSignal
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(signal.aborted).toBe(true)
    expect(importer.cancelGoogleImport).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Import from Google' }))
    await waitFor(() => expect(importer.loadGoogleCalendars).toHaveBeenCalledTimes(2))
    view.unmount()
    expect(importer.cancelGoogleImport).toHaveBeenCalledTimes(2)
    expect(onError).not.toHaveBeenCalled()
  })

  it('shows only fixed messages for failures', async () => {
    importer.loadGoogleCalendars.mockRejectedValue(new Error('ya29.secret in some library message'))
    const onError = vi.fn()
    render(<GoogleImportButton kind="calendar" onLoaded={vi.fn()} onError={onError} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Import from Google' })) })
    await waitFor(() => expect(onError).toHaveBeenCalledWith('The Google import failed. Please try again.'))
    expect(popup.close).toHaveBeenCalled()
  })
})
