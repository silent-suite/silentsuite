// Minimal Google Play Developer API (androidpublisher v3) client for the
// publication lane. No dependencies: the service-account JWT is signed with
// node:crypto and every call goes through an injectable fetch, so tests run
// without the network. Errors carry the HTTP status and Google's message only,
// never the key or the access token.

import { createSign } from 'node:crypto'

export const PACKAGE_NAME = 'io.silentsuite.android'
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications'
const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications'

export function parseServiceAccount(text) {
  let account
  try {
    account = JSON.parse(text)
  } catch {
    throw new Error('PLAY_SERVICE_ACCOUNT_JSON is not valid JSON')
  }
  if (account?.type !== 'service_account' || typeof account.client_email !== 'string' || typeof account.private_key !== 'string') {
    throw new Error('PLAY_SERVICE_ACCOUNT_JSON is not a service-account key')
  }
  return { clientEmail: account.client_email, privateKey: account.private_key }
}

export function signedAssertion({ clientEmail, privateKey }, now = Math.floor(Date.now() / 1000)) {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url')}`
}

async function failure(response, what) {
  let detail = ''
  try {
    const body = await response.json()
    detail = body?.error?.message ?? body?.error_description ?? body?.error ?? ''
  } catch {}
  return new Error(`${what} returned ${response.status}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`)
}

export async function accessToken(account, { fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedAssertion(account) }),
  })
  if (response.status !== 200) throw await failure(response, 'Google token exchange')
  const body = await response.json()
  if (typeof body.access_token !== 'string' || body.access_token === '') throw new Error('Google token exchange returned no access token')
  return body.access_token
}

export function createPlayClient({ token, fetchImpl = globalThis.fetch, packageName = PACKAGE_NAME }) {
  const auth = { Authorization: `Bearer ${token}` }
  const app = `${API}/${packageName}`

  async function call(method, url, what, { body, headers = {}, expect = 200 } = {}) {
    const response = await fetchImpl(url, { method, headers: { ...auth, ...headers }, body })
    if (response.status !== expect) throw await failure(response, what)
    return expect === 204 ? null : response.json()
  }
  const json = (value) => ({ body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } })
  const media = (bytes) => ({ body: bytes, headers: { 'Content-Type': 'application/octet-stream' } })

  return {
    async insertEdit() {
      const edit = await call('POST', `${app}/edits`, 'edits.insert')
      if (typeof edit?.id !== 'string' || edit.id === '') throw new Error('edits.insert returned no edit id')
      return edit.id
    },
    async listTracks(editId) {
      return (await call('GET', `${app}/edits/${editId}/tracks`, 'edits.tracks.list')).tracks ?? []
    },
    async listBundles(editId) {
      return (await call('GET', `${app}/edits/${editId}/bundles`, 'edits.bundles.list')).bundles ?? []
    },
    async uploadBundle(editId, bytes) {
      return call('POST', `${UPLOAD}/${packageName}/edits/${editId}/bundles?uploadType=media`, 'edits.bundles.upload', media(bytes))
    },
    async uploadNativeSymbols(editId, versionCode, bytes) {
      return call('POST', `${UPLOAD}/${packageName}/edits/${editId}/apks/${versionCode}/deobfuscationFiles/nativeCode?uploadType=media`, 'edits.deobfuscationfiles.upload', media(bytes))
    },
    async updateTrack(editId, track, releases) {
      return call('PUT', `${app}/edits/${editId}/tracks/${track}`, 'edits.tracks.update', json({ track, releases }))
    },
    async validateEdit(editId) {
      return call('POST', `${app}/edits/${editId}:validate`, 'edits.validate')
    },
    // A pending review (for example a listing change) fails the commit instead
    // of being cancelled; the next scheduled run retries.
    async commitEdit(editId) {
      return call('POST', `${app}/edits/${editId}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`, 'edits.commit')
    },
    async deleteEdit(editId) {
      return call('DELETE', `${app}/edits/${editId}`, 'edits.delete', { expect: 204 })
    },
  }
}
