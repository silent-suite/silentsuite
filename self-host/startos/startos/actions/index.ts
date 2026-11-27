import { sdk } from '../sdk'
import { showInstallationPassword } from './showInstallationPassword'

export const actions = sdk.Actions.of().addAction(showInstallationPassword)
