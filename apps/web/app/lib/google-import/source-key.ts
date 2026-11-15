/**
 * Where an imported item came from, kept inside the encrypted item as an X- property so a
 * later import of the same source skips it. The key is provider + account + container + item,
 * each part URI-encoded so no value can be mistaken for a separator or break the line.
 */
export const IMPORT_SOURCE_PROPERTY = 'X-SILENTSUITE-IMPORT-SOURCE'

export type ImportProvider = 'google' | 'microsoft'

export function importSourceKey(provider: ImportProvider, accountId: string, containerId: string, itemId: string): string {
  return [provider, accountId, containerId, itemId].map(encodeURIComponent).join('/')
}

export function importSourceLine(key: string): string {
  return `${IMPORT_SOURCE_PROPERTY}:${key}`
}

const SOURCE_LINE = new RegExp(`^${IMPORT_SOURCE_PROPERTY}(?:;[^:]*)?:(.+)$`, 'i')

/** The import source key held in an item's retained property lines, if any. */
export function importSourceKeyOf(unknownProperties: readonly string[] | undefined): string | undefined {
  for (const line of unknownProperties ?? []) {
    const match = SOURCE_LINE.exec(line)
    if (match) return match[1]!.trim()
  }
  return undefined
}

/** Every import source key found among items' retained property lines. */
export function importSourceKeys(items: readonly { unknownProperties?: readonly string[] }[]): Set<string> {
  const keys = new Set<string>()
  for (const item of items) {
    const key = importSourceKeyOf(item.unknownProperties)
    if (key) keys.add(key)
  }
  return keys
}
