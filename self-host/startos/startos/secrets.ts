// Per-install secrets. Pure module (no SDK import) so the repository contract test
// can exercise the lifecycle rules directly.

export type Secrets = {
  ownerPassword: string
  registrationSigning: string
  dbPassword: string
}

export const OWNER_PASSWORD_LENGTH = 48
export const HEX_SECRET_LENGTH = 64

const OWNER_PASSWORD_PATTERN = new RegExp(
  `^[A-Za-z0-9]{${OWNER_PASSWORD_LENGTH}}$`,
)
const HEX_SECRET_PATTERN = new RegExp(`^[0-9a-f]{${HEX_SECRET_LENGTH}}$`)

export type RandomString = (spec: { charset: string; len: number }) => string

/** Fresh secrets for a new installation. Only ever called on `kind === 'install'`. */
export function newSecrets(random: RandomString): Secrets {
  return validateSecrets({
    ownerPassword: random({
      charset: 'a-z,A-Z,0-9',
      len: OWNER_PASSWORD_LENGTH,
    }),
    registrationSigning: random({ charset: 'a-f,0-9', len: HEX_SECRET_LENGTH }),
    dbPassword: random({ charset: 'a-f,0-9', len: HEX_SECRET_LENGTH }),
  })
}

/**
 * Returns the stored secrets or throws. An existing installation must never get new
 * secrets: a new database password would lock the server out of its data and a new
 * owner password would silently change the installation credential.
 */
export function validateSecrets(
  stored: Partial<Record<keyof Secrets, unknown>> | null | undefined,
): Secrets {
  if (!stored)
    throw new Error('SilentSuite secrets are missing from store.json')
  const { ownerPassword, registrationSigning, dbPassword } = stored
  if (
    typeof ownerPassword !== 'string' ||
    !OWNER_PASSWORD_PATTERN.test(ownerPassword)
  ) {
    throw new Error(
      'SilentSuite owner password in store.json is missing or malformed',
    )
  }
  if (
    typeof registrationSigning !== 'string' ||
    !HEX_SECRET_PATTERN.test(registrationSigning)
  ) {
    throw new Error(
      'SilentSuite registration signing secret in store.json is missing or malformed',
    )
  }
  if (typeof dbPassword !== 'string' || !HEX_SECRET_PATTERN.test(dbPassword)) {
    throw new Error(
      'SilentSuite database password in store.json is missing or malformed',
    )
  }
  if (ownerPassword === registrationSigning) {
    throw new Error(
      'SilentSuite owner password must differ from the registration signing secret',
    )
  }
  return { ownerPassword, registrationSigning, dbPassword }
}

export const STORE_PARSE_ERROR =
  'SilentSuite store.json is unreadable or not valid JSON'

/**
 * JSON parser for store.json. JSON.parse error messages can quote part of the file, which
 * would put secret text into the logs, so every parse failure (the first read and every
 * later re-read by StartOS's file watcher) becomes one fixed message.
 */
export function parseStoreText(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(STORE_PARSE_ERROR)
  }
}
