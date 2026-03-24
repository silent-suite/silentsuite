import { NextRequest, NextResponse } from 'next/server'

import { Resend } from 'resend'

let _resend: Resend | null = null
function getResend(): Resend {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY)
  return _resend
}

function hexEncode(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function verifySignature(
  email: string,
  sig: string,
  secret: string,
): Promise<boolean> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const data = encoder.encode(`unsubscribe|${email}`)
  const expected = await crypto.subtle.sign('HMAC', key, data)
  return hexEncode(expected) === sig
}

async function removeContact(email: string): Promise<void> {
  const audienceId = process.env.RESEND_AUDIENCE_ID
  if (!audienceId) {
    console.error('RESEND_AUDIENCE_ID not configured')
    return
  }

  try {
    await getResend().contacts.remove({ email, audienceId })
  } catch (err) {
    console.error('Failed to remove contact from audience:', err)
  }
}

// GET: browser click from email link (HMAC-signed)
export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get('email')
  const sig = req.nextUrl.searchParams.get('sig')

  if (!email || !sig) {
    return NextResponse.redirect(new URL('/waitlist/error?reason=missing-token', req.url))
  }

  const secret = process.env.NEWSLETTER_SECRET
  if (!secret) {
    console.error('NEWSLETTER_SECRET not configured')
    return NextResponse.redirect(new URL('/waitlist/error?reason=server-error', req.url))
  }

  const valid = await verifySignature(email, sig, secret)
  if (!valid) {
    return NextResponse.redirect(new URL('/waitlist/error?reason=invalid-token', req.url))
  }

  await removeContact(email)

  return NextResponse.redirect(new URL('/waitlist/unsubscribed', req.url))
}

// POST: RFC 8058 one-click unsubscribe from email client
export async function POST(req: NextRequest) {
  const email = req.nextUrl.searchParams.get('email')
  const sig = req.nextUrl.searchParams.get('sig')

  if (!email || !sig) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 })
  }

  const secret = process.env.NEWSLETTER_SECRET
  if (!secret) {
    console.error('NEWSLETTER_SECRET not configured')
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  const valid = await verifySignature(email, sig, secret)
  if (!valid) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 403 })
  }

  await removeContact(email)

  return NextResponse.json({ ok: true })
}
