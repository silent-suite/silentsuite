/** Normalize a server URL: trim, add https:// if no protocol present. */
export function normalizeServerUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return trimmed
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`
  return trimmed
}
