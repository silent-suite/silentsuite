import { NextRequest, NextResponse } from 'next/server'

import { Resend } from 'resend'

let _resend: Resend | null = null
function getResend(): Resend {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY)
  return _resend
}

// Rate limiter: 10 confirmation attempts per IP per 15 minutes.
// Resets on each Worker cold start, which is acceptable for basic protection.
// For production-grade rate limiting, use Cloudflare WAF rules.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const RATE_LIMIT_MAX = 10
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return false
  }

  entry.count++
  return entry.count > RATE_LIMIT_MAX
}

function hexEncode(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function verifySignature(
  email: string,
  ts: number,
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
  const data = encoder.encode(`${email}|${ts}`)
  const expected = await crypto.subtle.sign('HMAC', key, data)
  return hexEncode(expected) === sig
}

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000

export async function GET(req: NextRequest) {
  // Rate limiting
  const ip =
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'

  if (isRateLimited(ip)) {
    return NextResponse.redirect(new URL('/waitlist/error?reason=rate-limited', req.url))
  }

  const email = req.nextUrl.searchParams.get('email')
  const tsParam = req.nextUrl.searchParams.get('ts')
  const sig = req.nextUrl.searchParams.get('sig')

  if (!email || !tsParam || !sig) {
    return NextResponse.redirect(new URL('/waitlist/error?reason=missing-token', req.url))
  }

  const ts = Number(tsParam)
  if (isNaN(ts)) {
    return NextResponse.redirect(new URL('/waitlist/error?reason=invalid-token', req.url))
  }

  // Check 48-hour expiry
  if (Date.now() - ts > FORTY_EIGHT_HOURS_MS) {
    return NextResponse.redirect(new URL('/waitlist/error?reason=expired', req.url))
  }

  const secret = process.env.NEWSLETTER_SECRET
  if (!secret) {
    console.error('NEWSLETTER_SECRET not configured')
    return NextResponse.redirect(new URL('/waitlist/error?reason=server-error', req.url))
  }

  // Verify HMAC signature
  const valid = await verifySignature(email, ts, sig, secret)
  if (!valid) {
    return NextResponse.redirect(new URL('/waitlist/error?reason=invalid-token', req.url))
  }

  // Persist the confirmed subscriber to Resend Audience
  const audienceId = process.env.RESEND_AUDIENCE_ID
  if (audienceId) {
    try {
      await getResend().contacts.create({ email, audienceId })
    } catch (err) {
      console.error('Failed to add contact to audience:', err)
    }
  } else {
    console.error('RESEND_AUDIENCE_ID not configured; subscriber not stored')
  }

  // Send the welcome email
  try {
    const { error: sendError } = await getResend().emails.send({
      from: 'SilentSuite <noreply@silentsuite.io>',
      to: email,
      subject: 'Welcome to SilentSuite updates',
      headers: {
        'List-Unsubscribe': '<mailto:unsubscribe@silentsuite.io>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      html: `
        <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
          <h2>Hi there,</h2>
          <p>Thanks for confirming your subscription to SilentSuite updates.</p>
          <p>
            SilentSuite is an end-to-end encrypted calendar, contacts, and tasks
            sync service. Your data is encrypted on your device before it ever
            leaves. Not even we can read it.
          </p>
          <p>Here is what you get:</p>
          <ul>
            <li>Calendar, contacts, and tasks sync across all your devices</li>
            <li>End-to-end encryption with zero-knowledge architecture</li>
            <li>Web app, Android app, and CalDAV bridge</li>
            <li>Open-source server you can self-host</li>
          </ul>
          <p>
            Ready to try it?
            <a href="https://app.silentsuite.io/signup">Create your account</a>
            and get started.
          </p>
          <p>
            We will send you occasional product updates and feature announcements.
            No spam, ever.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;" />
          <p style="font-size: 12px; color: #888;">
            You received this email because you confirmed your subscription on
            silentsuite.io. To unsubscribe, reply to this email with
            "unsubscribe" or email
            <a href="mailto:info@silentsuite.io">info@silentsuite.io</a>.
            <br />
            <a href="mailto:unsubscribe@silentsuite.io">One-click unsubscribe</a>
          </p>
        </div>
      `,
    })

    if (sendError) {
      console.error('Resend error:', sendError)
      return NextResponse.redirect(new URL('/waitlist/error?reason=server-error', req.url))
    }

    return NextResponse.redirect(new URL('/waitlist/confirmed', req.url))
  } catch (err) {
    console.error('Confirmation API error:', err)
    return NextResponse.redirect(new URL('/waitlist/error?reason=server-error', req.url))
  }
}
