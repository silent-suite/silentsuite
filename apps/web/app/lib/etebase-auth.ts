import { ETEBASE_SERVER_URL } from '@/app/lib/config'

interface EtebaseAuthResult {
  authToken: string
  savedSession: string
}

/** Mint immediately before a Billing request. The proof is never persisted. */
export async function issueBillingLinkProof(savedSession: string, serverUrl?: string): Promise<string> {
  const { restoreSession } = await import('@silentsuite/core')
  const account = await restoreSession(serverUrl || ETEBASE_SERVER_URL, savedSession)
  const authToken = (account as any).authToken as string
  const endpoint = `${(serverUrl || ETEBASE_SERVER_URL).replace(/\/$/, '')}/api/v1/billing/link-proof/`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST', headers: { Authorization: 'Token ' + authToken },
      })
    } catch {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        continue
      }
      throw new Error('Could not establish billing identity')
    }
    if (response.status === 429 && attempt === 0) {
      const requestedDelay = Number.parseInt(response.headers.get('Retry-After') ?? '1', 10)
      const retrySeconds = Number.isFinite(requestedDelay) ? Math.min(Math.max(requestedDelay, 1), 2) : 1
      await new Promise((resolve) => setTimeout(resolve, retrySeconds * 1_000))
      continue
    }
    if (!response.ok) throw new Error('Could not establish billing identity')
    const value = await response.json() as { etebaseLinkProof?: unknown }
    if (typeof value.etebaseLinkProof !== 'string') throw new Error('Could not establish billing identity')
    return value.etebaseLinkProof
  }
  throw new Error('Could not establish billing identity')
}

export async function etebaseSignUp(
  email: string,
  password: string,
  serverUrl?: string,
): Promise<EtebaseAuthResult> {
  await new Promise((r) => setTimeout(r, 50))
  const { signUp, saveSession } = await import('@silentsuite/core')
  const account = await signUp(serverUrl || ETEBASE_SERVER_URL, email, password)
  const authToken = (account as any).authToken as string
  const savedSession = await saveSession(account)
  return { authToken, savedSession }
}

export async function etebaseLogIn(
  email: string,
  password: string,
  serverUrl?: string,
): Promise<EtebaseAuthResult> {
  await new Promise((r) => setTimeout(r, 50))
  const { logIn, saveSession } = await import('@silentsuite/core')
  const account = await logIn(serverUrl || ETEBASE_SERVER_URL, email, password)
  const authToken = (account as any).authToken as string
  const savedSession = await saveSession(account)
  return { authToken, savedSession }
}
