'use client'

import { MICROSOFT_IMPORT_CLIENT_ID } from '@/app/lib/config'
import ProviderImportButton, { providerImportEnabled, type ProviderDescriptor, type ProviderImportButtonProps } from './ProviderImportButton'

export function microsoftImportEnabled(clientId: string | undefined = MICROSOFT_IMPORT_CLIENT_ID): boolean {
  return providerImportEnabled(clientId)
}

/** Where a user removes the permission: personal Microsoft accounts, and work or school accounts. */
export const MICROSOFT_PERSONAL_CONSENT_URL = 'https://account.live.com/consent/Manage'
export const MICROSOFT_WORK_APPS_URL = 'https://myapps.microsoft.com'

const LINK = 'text-emerald-500 hover:text-emerald-400'

/** "Import from Microsoft": hidden unless the build has a Microsoft client ID (see ProviderImportButton). */
export default function MicrosoftImportButton(props: ProviderImportButtonProps) {
  const provider: ProviderDescriptor = {
    label: 'Microsoft',
    clientId: MICROSOFT_IMPORT_CLIENT_ID ?? '',
    // Name and features shared with app/lib/microsoft-import/oauth.ts, which navigates this popup.
    popupName: 'silentsuite-microsoft-import',
    popupFeatures: 'popup,width=520,height=680',
    load: async () => {
      const importer = await import('@/app/lib/microsoft-import/importer')
      return { loadCalendars: importer.loadMicrosoftCalendars, loadContacts: importer.loadMicrosoftContacts, cancel: importer.cancelMicrosoftImport }
    },
    knownErrors: ['MicrosoftAuthError', 'GraphApiError', 'MicrosoftImportError'],
    failedMessage: 'The Microsoft import failed. Please try again.',
    notice: (
      <>
        For Outlook.com and Microsoft 365. A work or school account may need your organization&apos;s administrator to approve SilentSuite first.
        After the import, SilentSuite keeps no access to your Microsoft account. Microsoft still lists the permission until you remove it under{' '}
        <a href={MICROSOFT_PERSONAL_CONSENT_URL} target="_blank" rel="noopener noreferrer" className={LINK}>app permissions</a>
        {' '}(personal accounts) or{' '}
        <a href={MICROSOFT_WORK_APPS_URL} target="_blank" rel="noopener noreferrer" className={LINK}>My Apps</a>
        {' '}(work or school).
      </>
    ),
  }
  return <ProviderImportButton {...props} provider={provider} />
}
