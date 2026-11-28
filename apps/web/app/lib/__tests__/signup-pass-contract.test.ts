import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { requestSignupPass } from '../billing-v2'

// Verbatim copy of the shared S1/S2/S3 contract fixture; the checksum pins it.
const FIXTURE = path.resolve(process.cwd(), 'src/__tests__/fixtures/signup-pass-contract.v2.json')
const SHA256 = '7edfa4d7e95ac412bb506a75f65ee8f59f571dd76e9f97dbf15de6f4ba06e6e8'
const raw = readFileSync(FIXTURE)
const contract = JSON.parse(raw.toString('utf8'))
const billing = contract.billing
const email = 'owner@example.test'

function recorder(status: number, body: unknown) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }))
}

describe('signup pass contract v2 fixture', () => {
  it('is the pinned shared copy', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(SHA256)
    expect(contract.contractVersion).toBe(2)
    expect(contract.header).toBe('x-silentsuite-registration-token')
    expect(contract.ttlSeconds).toBe(600)
  })

  it('the web calls the contract route with the exact request shape of each kind', async () => {
    const authorities = {
      intent: { kind: 'intent' as const, checkoutIntentToken: 'signed.checkout.intent' },
      ownership: { kind: 'ownership' as const, requestId: 'request-1', emailOwnershipToken: 'signed.ownership.token' },
    }
    for (const kind of ['intent', 'ownership'] as const) {
      const fetcher = recorder(200, { signupPass: 'P'.repeat(43), expiresIn: 600 })
      await requestSignupPass({ fetcher, billingApiUrl: 'https://billing.test', email, authority: authorities[kind] })
      const [url, init] = fetcher.mock.calls[0]
      expect(init?.method).toBe(billing.method)
      expect(String(url)).toBe(`https://billing.test${billing.route}`)
      const sent = JSON.parse(String(init?.body))
      const shape = billing.requests[kind]
      expect(Object.keys(sent).sort()).toEqual(Object.keys(shape).sort())
      expect(sent.contractVersion).toBe(shape.contractVersion)
      expect(sent.kind).toBe(shape.kind)
    }
  })

  it('accepts the 200 shape with a pass of the contract length', async () => {
    expect(Object.keys(billing.responses['200']).sort()).toEqual(['expiresIn', 'signupPass'])
    const signupPass = 'x'.repeat(contract.pass.length)
    const outcome = await requestSignupPass({ fetcher: recorder(200, { ...billing.responses['200'], signupPass }), billingApiUrl: 'https://billing.test', email,
      authority: { kind: 'intent', checkoutIntentToken: 't' } })
    expect(outcome).toEqual({ kind: 'pass', signupPass })
  })

  it('maps only the contract 409 code to name-taken; every other listed response lets the server decide', async () => {
    const run = (status: number, body: unknown) => requestSignupPass({ fetcher: recorder(status, body), billingApiUrl: 'https://billing.test', email,
      authority: { kind: 'intent', checkoutIntentToken: 't' } })
    expect(await run(409, billing.responses['409'])).toEqual({ kind: 'name-taken' })
    for (const body of billing.responses['400']) expect(await run(400, body)).toEqual({ kind: 'unavailable' })
    expect(await run(404, billing.responses['404'])).toEqual({ kind: 'unavailable' })
    expect(await run(503, billing.responses['503'])).toEqual({ kind: 'unavailable' })
  })

  it('the server refusal the web branches on is the 403 the SDK maps to PermissionDeniedError', () => {
    expect(contract.server.signupRefusal).toEqual({ status: 403, code: 'registration_token_required' })
  })
})
