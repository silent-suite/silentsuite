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

async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
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
    const sig = await signPayload(`${email}|${ts}`, secret)
    const confirmUrl =
      `https://silentsuite.io/api/newsletter/confirm?email=${encodeURIComponent(email)}&ts=${ts}&sig=${sig}`

    const { error: sendError } = await getResend().emails.send({
      from: 'SilentSuite <noreply@silentsuite.io>',
      to: email,
      subject: 'Confirm your SilentSuite newsletter subscription',
      html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin: 0; padding: 0; background-color: #060a12; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #060a12;">
<tr><td align="center" style="padding: 0;">

<!-- Emerald accent bar -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="height: 3px; background: linear-gradient(to right, #059669, #10b981, #34d399, #10b981, #059669);"></td></tr></table>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding: 32px 16px 0;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%;">

<!-- Logo -->
<tr><td style="padding: 0 0 28px; text-align: center;">
<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 auto;"><tr>
<td style="padding-right: 10px; vertical-align: middle;">
<img src="https://silentsuite.io/email/shield-plain.png" width="24" height="24" alt="SilentSuite" style="display: block; border: 0;" />
</td>
<td style="vertical-align: middle;">
<span style="font-size: 20px; font-weight: 700; color: #f8fafc; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; letter-spacing: -0.5px;">SilentSuite</span>
</td>
</tr></table>
</td></tr>

<!-- Hero Banner -->
<tr><td>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 0;">
<tr><td style="background: linear-gradient(160deg, #0a1018 0%, #0c2e1f 40%, #132f4a 100%); border-radius: 12px 12px 0 0; padding: 48px 32px 40px; text-align: center;">
<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 auto 24px;">
<tr><td style="text-align: center; background-color: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.2); border-radius: 16px; padding: 14px; line-height: 0;">
<img src="https://silentsuite.io/email/shield.png" width="48" height="48" alt="Shield" style="display: block; border: 0;" />
</td></tr>
</table>
<h1 style="margin: 0 0 10px; font-size: 26px; font-weight: 700; color: #f8fafc; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; letter-spacing: -0.5px; line-height: 1.3;">Confirm your subscription</h1>
<p style="margin: 0; font-size: 15px; color: #94a3b8; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.5;">${escapeHtml(email)}</p>
</td></tr>
</table>
</td></tr>

<!-- Body -->
<tr><td style="background-color: #0f1729; border-radius: 0 0 12px 12px; padding: 36px 36px 40px; border-top: 1px solid #1a2640;">
<p style="margin: 0 0 18px; font-size: 15px; line-height: 1.7; color: #94a3b8; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">${greeting} Thanks for subscribing to the SilentSuite newsletter. Click the button below to confirm your email address.</p>

<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 28px auto;" align="center"><tr><td style="text-align: center; background: linear-gradient(135deg, #10b981 0%, #059669 100%); border-radius: 10px; mso-padding-alt: 0; box-shadow: 0 4px 14px rgba(16, 185, 129, 0.25);"><a href="${confirmUrl}" style="display: inline-block; padding: 16px 40px; color: #ffffff; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 16px; font-weight: 600; text-decoration: none; letter-spacing: 0.3px;">Confirm subscription</a></td></tr></table>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 32px 0;"><tr><td style="height: 1px; background: linear-gradient(to right, transparent, #1e293b, transparent);"></td></tr></table>

<p style="margin: 0 0 18px; font-size: 15px; line-height: 1.7; color: #94a3b8; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">If the button doesn't work, copy and paste this link into your browser:</p>
<p style="margin: 0 0 18px; font-size: 15px; line-height: 1.7; color: #94a3b8; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;"><a href="${confirmUrl}" style="color: #34d399; word-break: break-all;">${confirmUrl}</a></p>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 24px 0;"><tr><td style="background-color: #0a1a14; border-left: 3px solid #10b981; border-radius: 0 10px 10px 0; padding: 18px 22px;">
<p style="margin: 0; font-size: 14px; line-height: 1.65; color: #94a3b8; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">This link expires in 48 hours. If you didn't subscribe, you can safely ignore this email.</p>
</td></tr></table>
</td></tr>

<!-- Footer -->
<tr><td style="padding: 32px 16px 24px; text-align: center;">
<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 auto 18px;"><tr><td style="background-color: #071a10; border: 1px solid #14532d; border-radius: 100px; padding: 7px 18px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="vertical-align: middle; padding-right: 6px; line-height: 0;"><img src="https://silentsuite.io/email/lock-badge.png" width="12" height="12" alt="Lock" style="display: block; border: 0;" /></td>
<td style="vertical-align: middle;"><span style="font-size: 11px; font-weight: 600; color: #4ade80; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; letter-spacing: 0.3px;">End-to-end encrypted</span></td>
</tr></table>
</td></tr></table>
<p style="margin: 0 0 14px; font-size: 13px; color: #64748b; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
<a href="https://silentsuite.io" style="color: #64748b; text-decoration: underline; text-underline-offset: 2px; text-decoration-color: #334155;">Website</a><span style="color: #334155;">&nbsp;&nbsp;·&nbsp;&nbsp;</span><a href="https://docs.silentsuite.io" style="color: #64748b; text-decoration: underline; text-underline-offset: 2px; text-decoration-color: #334155;">Docs</a><span style="color: #334155;">&nbsp;&nbsp;·&nbsp;&nbsp;</span><a href="https://silentsuite.io/blog" style="color: #64748b; text-decoration: underline; text-underline-offset: 2px; text-decoration-color: #334155;">Blog</a>
</p>
<p style="margin: 0 0 8px; font-size: 12px; color: #475569; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">SilentSuite. Private by design.</p>
<p style="margin: 0; font-size: 11px; color: #475569; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">You received this email because someone entered your address on silentsuite.io</p>
</td></tr>

</table>
</td></tr></table>
</td></tr>
</table>
</body>
</html>`,
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
