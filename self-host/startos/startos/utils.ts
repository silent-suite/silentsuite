import { T } from '@start9labs/start-sdk'
import { sdk } from './sdk'

export const routerPort = 8080
export const serverPort = 3735
export const webPort = 3000
export const postgresPort = 5432

export const postgresUser = 'silentsuite'
export const postgresDb = 'silentsuite'
// Password-checked TCP even on loopback; the unix socket (private to the postgres
// subcontainer) stays trust for the SDK's dump/restore path. Also passed to the
// SDK's restore-time initdb, so restored clusters get the same rules.
export const postgresInitdbArgs = [
  '--auth-host=scram-sha-256',
  '--auth-local=trust',
]
export const postgresMount = '/var/lib/postgresql'
export const pgdata = '/var/lib/postgresql/data'

export const hostId = 'main'
export const interfaceId = 'ui'

export const discoveryPath = '/api/v1/authentication/is_etebase/'
// The web root redirects to /calendar; /signup answers 200 without a session.
export const webReadyPath = '/signup'

export function postgresSub(effects: T.Effects, name: string) {
  return sdk.SubContainer.of(
    effects,
    { imageId: 'postgres' },
    sdk.Mounts.of().mountVolume({
      volumeId: 'db',
      subpath: null,
      mountpoint: postgresMount,
      readonly: false,
    }),
    name,
  )
}

/** Ready only on HTTP 200: a 5xx backend or a router answering 502 is not ready. */
export async function httpOk(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 5000,
): Promise<boolean> {
  try {
    const response = await fetch(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.status === 200
  } catch {
    return false
  }
}
