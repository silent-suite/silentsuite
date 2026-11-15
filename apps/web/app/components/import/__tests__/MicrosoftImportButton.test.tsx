import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const config = vi.hoisted(() => ({ MICROSOFT_IMPORT_CLIENT_ID: '' }))
vi.mock('@/app/lib/config', () => config)

const importer = vi.hoisted(() => ({
  evaluated: vi.fn(),
  loadMicrosoftCalendars: vi.fn(),
  loadMicrosoftContacts: vi.fn(),
  cancelMicrosoftImport: vi.fn(),
}))
vi.mock('@/app/lib/microsoft-import/importer', () => {
  importer.evaluated()
  return importer
})

import MicrosoftImportButton from '../MicrosoftImportButton'

describe('Import from Microsoft button (#48)', () => {
  const popup = { close: vi.fn(), closed: false }
  beforeEach(() => {
    config.MICROSOFT_IMPORT_CLIENT_ID = '00000000-0000-0000-0000-000000000001'
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    importer.loadMicrosoftCalendars.mockReset()
    importer.loadMicrosoftContacts.mockReset()
    importer.cancelMicrosoftImport.mockReset()
    popup.close.mockReset()
  })
  afterEach(() => vi.restoreAllMocks())

  it('is hidden when no Microsoft client ID is configured', () => {
    config.MICROSOFT_IMPORT_CLIENT_ID = ''
    const { container } = render(<MicrosoftImportButton kind="calendar" onLoaded={vi.fn()} onError={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says work accounts may need admin approval, no access is kept, and where the permission is removed', () => {
    render(<MicrosoftImportButton kind="contacts" onLoaded={vi.fn()} onError={vi.fn()} />)
    expect(screen.getByText(/may need your organization's administrator to approve SilentSuite first/)).toBeInTheDocument()
    expect(screen.getByText(/SilentSuite keeps no access to your Microsoft account/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'app permissions' })).toHaveAttribute('href', 'https://account.live.com/consent/Manage')
    expect(screen.getByRole('link', { name: 'My Apps' })).toHaveAttribute('href', 'https://myapps.microsoft.com')
    for (const link of screen.getAllByRole('link')) expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('loads the importer only when clicked, opening the popup inside the click', async () => {
    const onLoaded = vi.fn()
    const result = [{ uid: '', fn: 'Ann', sourceKey: 'microsoft/a/contacts/1' }]
    importer.loadMicrosoftContacts.mockResolvedValue(result)
    render(<MicrosoftImportButton kind="contacts" onLoaded={onLoaded} onError={vi.fn()} />)
    expect(importer.evaluated).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Import from Microsoft' }))
    expect(window.open).toHaveBeenCalledWith('about:blank', 'silentsuite-microsoft-import-contacts', 'popup,width=520,height=680')
    await waitFor(() => expect(onLoaded).toHaveBeenCalledWith(result))
    expect(importer.loadMicrosoftContacts).toHaveBeenCalledWith(expect.objectContaining({ clientId: '00000000-0000-0000-0000-000000000001', popup }))
  })

  it('calendar and contacts runs use different popup windows', () => {
    render(<><MicrosoftImportButton kind="calendar" onLoaded={vi.fn()} onError={vi.fn()} /><MicrosoftImportButton kind="contacts" onLoaded={vi.fn()} onError={vi.fn()} /></>)
    importer.loadMicrosoftCalendars.mockReturnValue(new Promise(() => undefined))
    importer.loadMicrosoftContacts.mockReturnValue(new Promise(() => undefined))
    for (const button of screen.getAllByRole('button', { name: 'Import from Microsoft' })) fireEvent.click(button)
    const names = (window.open as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => call[1])
    expect(names).toEqual(['silentsuite-microsoft-import-calendar', 'silentsuite-microsoft-import-contacts'])
  })

  it('cancel and leaving the page end the run and drop the token', async () => {
    importer.loadMicrosoftCalendars.mockReturnValue(new Promise(() => undefined))
    const view = render(<MicrosoftImportButton kind="calendar" onLoaded={vi.fn()} onError={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Import from Microsoft' }))
    await waitFor(() => expect(importer.loadMicrosoftCalendars).toHaveBeenCalled())
    const signal = importer.loadMicrosoftCalendars.mock.calls[0]![0].signal as AbortSignal
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(signal.aborted).toBe(true)
    expect(importer.cancelMicrosoftImport).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Import from Microsoft' }))
    await waitFor(() => expect(importer.loadMicrosoftCalendars).toHaveBeenCalledTimes(2))
    view.unmount()
    expect(importer.cancelMicrosoftImport).toHaveBeenCalledTimes(2)
  })

  it('shows our own messages for known failures and a fixed one otherwise', async () => {
    const admin = Object.assign(new Error('Your organization needs an administrator to approve SilentSuite before you can import from this account.'), { name: 'MicrosoftAuthError' })
    importer.loadMicrosoftCalendars.mockRejectedValueOnce(admin).mockRejectedValueOnce(new Error('eyJ0eXAi.secret in a library message'))
    const onError = vi.fn()
    render(<MicrosoftImportButton kind="calendar" onLoaded={vi.fn()} onError={onError} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Import from Microsoft' })) })
    await waitFor(() => expect(onError).toHaveBeenCalledWith(admin.message))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Import from Microsoft' })) })
    await waitFor(() => expect(onError).toHaveBeenLastCalledWith('The Microsoft import failed. Please try again.'))
    expect(popup.close).toHaveBeenCalled()
  })
})
