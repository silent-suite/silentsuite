import { NextRequest, NextResponse } from 'next/server'

import { Resend } from 'resend'

let _resend: Resend | null = null
function getResend(): Resend {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY)
  return _resend
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Simple in-memory rate limiter.
// Resets on each Worker cold start, which is acceptable for basic protection.
// For production-grade rate limiting, use Cloudflare WAF rules.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const RATE_LIMIT_MAX = 5
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

function isRateLimited(ip: string): { limited: boolean; retryAfter?: number } {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return { limited: false }
  }

  entry.count++
  if (entry.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000)
    return { limited: true, retryAfter }
  }
  return { limited: false }
}

function hexEncode(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function signPayload(email: string, ts: number, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const data = encoder.encode(`${email}|${ts}`)
  const signature = await crypto.subtle.sign('HMAC', key, data)
  return hexEncode(signature)
}

export async function POST(req: NextRequest) {
  // Rate limiting by IP
  const ip =
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'

  const { limited, retryAfter } = isRateLimited(ip)
  if (limited) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      {
        status: 429,
        headers: { 'Retry-After': String(retryAfter) },
      },
    )
  }

  try {
    const { email, name, consent } = await req.json()

    if (!email || typeof email !== 'string' || !email.includes('@') || !email.includes('.')) {
      return NextResponse.json({ error: 'A valid email is required' }, { status: 400 })
    }

    if (consent !== true) {
      return NextResponse.json({ error: 'Consent is required' }, { status: 400 })
    }

    const secret = process.env.NEWSLETTER_SECRET
    if (!secret) {
      console.error('NEWSLETTER_SECRET not configured')
      return NextResponse.json({ error: 'Internal error' }, { status: 500 })
    }

    const firstName = name ? String(name).split(' ')[0] : ''
    const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi there,'

    // Generate HMAC-signed confirmation link (stateless double opt-in)
    const ts = Date.now()
    const sig = await signPayload(email, ts, secret)
    const confirmUrl =
      `https://silentsuite.io/api/waitlist/confirm?email=${encodeURIComponent(email)}&ts=${ts}&sig=${sig}`

    const { error: sendError } = await getResend().emails.send({
      from: 'SilentSuite <noreply@silentsuite.io>',
      to: email,
      subject: 'Please confirm your subscription to SilentSuite updates',
      headers: {
        'List-Unsubscribe': '<mailto:unsubscribe@silentsuite.io>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      html: `
        <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
          <h2>${greeting}</h2>
          <p>
            Thanks for signing up for SilentSuite updates. Please confirm your
            subscription by clicking the button below.
          </p>
          <p style="text-align: center; margin: 32px 0;">
            <a href="${confirmUrl}"
               style="display: inline-block; padding: 14px 32px; background-color: #2dd4bf; color: #0a0f1a; font-weight: 600; text-decoration: none; border-radius: 8px;">
              Confirm my subscription
            </a>
          </p>
          <p style="font-size: 14px; color: #666;">
            If the button does not work, copy and paste this link into your browser:
          </p>
          <p style="font-size: 13px; color: #888; word-break: break-all;">
            ${confirmUrl}
          </p>
          <p style="font-size: 14px; color: #666;">
            This link expires in 48 hours. If you did not request this, you can
            safely ignore this email.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;" />
          <p style="font-size: 12px; color: #888;">
            You received this email because someone entered your address on
            silentsuite.io. If this was not you, no action is needed.
            <br />
            <a href="mailto:unsubscribe@silentsuite.io">Unsubscribe</a>
          </p>
        </div>
      `,
    })

    if (sendError) {
      console.error('Resend error:', sendError)
      return NextResponse.json({ error: 'Failed to send email' }, { status: 502 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Newsletter API error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
