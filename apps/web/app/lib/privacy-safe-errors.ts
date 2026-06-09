export function getSafeErrorName(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error'
  if (error === null) return 'null'
  return typeof error
}

/**
 * Keep console/Sentry details intentionally sparse: error messages and stacks
 * can contain decrypted item content, parser input, URLs, or auth material.
 */
export function getSafeErrorDetails(error: unknown): { errorName: string } {
  return { errorName: getSafeErrorName(error) }
}

export function createSafeOperationalError(component: string, operation: string): Error {
  return new Error(`${component}: ${operation} failed`)
}
