import { FileHelper, z } from '@start9labs/start-sdk'
import { parseStoreText } from '../secrets'
import { sdk } from '../sdk'

// The `startos` volume is mounted into no subcontainer; only this package's own
// StartOS-side code reads it.
const shape = z.looseObject({
  ownerPassword: z.string().optional().catch(undefined),
  registrationSigning: z.string().optional().catch(undefined),
  dbPassword: z.string().optional().catch(undefined),
})

// FileHelper.json, except that a parse error never quotes the file (see parseStoreText).
export const storeJson = FileHelper.raw(
  { base: sdk.volumes.startos, subpath: 'store.json' },
  (data: z.infer<typeof shape>) => JSON.stringify(data, null, 2),
  parseStoreText,
  (data) => shape.parse(data),
)
