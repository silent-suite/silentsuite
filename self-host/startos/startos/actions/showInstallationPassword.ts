import { secretsFromStoreOnce } from '../init/initializeService'
import { i18n } from '../i18n'
import { sdk } from '../sdk'

export const showInstallationPassword = sdk.Action.withoutInput(
  'show-installation-password',

  async () => ({
    name: i18n('Show Installation Password'),
    description: i18n(
      'Shows the installation password that every new SilentSuite account needs at sign-up.',
    ),
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  async () => {
    const { ownerPassword } = await secretsFromStoreOnce()
    return {
      version: '1',
      title: i18n('Installation password'),
      message: i18n(
        'Use this as the installation password when you choose Sign up. Your account password is separate and never leaves your device.',
      ),
      result: {
        type: 'single',
        value: ownerPassword,
        masked: true,
        copyable: true,
        qr: false,
        launchable: false,
      },
    }
  },
)
