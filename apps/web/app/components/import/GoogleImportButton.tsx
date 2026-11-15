'use client'

import { GOOGLE_IMPORT_CLIENT_ID } from '@/app/lib/config'
import ProviderImportButton, { providerImportEnabled, type ProviderDescriptor, type ProviderImportButtonProps } from './ProviderImportButton'

export function googleImportEnabled(clientId: string = GOOGLE_IMPORT_CLIENT_ID): boolean {
  return providerImportEnabled(clientId)
}

/** Where a user removes the permission at Google; ending the import does not revoke it. */
export const GOOGLE_CONNECTIONS_URL = 'https://myaccount.google.com/connections'

const LINK = 'text-emerald-500 hover:text-emerald-400'

/** "Import from Google": hidden unless the build has a Google client ID (see ProviderImportButton). */
export default function GoogleImportButton(props: ProviderImportButtonProps) {
  const provider: ProviderDescriptor = {
    label: 'Google',
    clientId: GOOGLE_IMPORT_CLIENT_ID,
    // Name and features shared with app/lib/google-import/oauth.ts, which navigates this popup.
    popupName: 'silentsuite-google-import',
    popupFeatures: 'popup,width=520,height=680',
    load: async () => {
      const importer = await import('@/app/lib/google-import/importer')
      return { loadCalendars: importer.loadGoogleCalendars, loadContacts: importer.loadGoogleContacts, cancel: importer.cancelGoogleImport }
    },
    knownErrors: ['GoogleAuthError', 'GoogleApiError', 'GoogleImportError'],
    failedMessage: 'The Google import failed. Please try again.',
    notice: (
      <>
        After the import, SilentSuite keeps no access to your Google account. Google still lists the permission until you remove it under{' '}
        <a href={GOOGLE_CONNECTIONS_URL} target="_blank" rel="noopener noreferrer" className={LINK}>third-party connections</a>
        .
      </>
    ),
  }
  return <ProviderImportButton {...props} provider={provider} />
}
