import { ETEBASE_SERVER_URL } from '@/app/lib/config'

interface EtebaseAuthResult {
  authToken: string
  savedSession: string
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
