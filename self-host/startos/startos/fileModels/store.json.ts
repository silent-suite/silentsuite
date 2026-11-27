import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

// The `startos` volume is mounted into no subcontainer; only this package's own
// StartOS-side code reads it.
const shape = z.looseObject({
  ownerPassword: z.string().optional().catch(undefined),
  registrationSigning: z.string().optional().catch(undefined),
  dbPassword: z.string().optional().catch(undefined),
})

export const storeJson = FileHelper.json(
  { base: sdk.volumes.startos, subpath: 'store.json' },
  shape,
)
