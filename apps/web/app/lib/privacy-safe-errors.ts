export function getSafeErrorName(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error'
  if (error === null) return 'null'
  return typeof error
}

export function getSafeErrorDetails(error: unknown): { errorName: string } {
  return { errorName: getSafeErrorName(error) }
}

export function createSafeOperationalError(component: string, operation: string): Error {
  return new Error(`${component}: ${operation} failed`)
}
