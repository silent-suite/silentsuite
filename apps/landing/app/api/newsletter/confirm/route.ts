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

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000

export async function GET(req: NextRequest) {
  // Rate limiting
  const ip =
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'

  if (isRateLimited(ip)) {
    return NextResponse.redirect(new URL('/newsletter/error?reason=rate-limited', req.url))
  }

  const email = req.nextUrl.searchParams.get('email')
  const tsParam = req.nextUrl.searchParams.get('ts')
  const sig = req.nextUrl.searchParams.get('sig')

  if (!email || !tsParam || !sig) {
    return NextResponse.redirect(new URL('/newsletter/error?reason=missing-token', req.url))
  }

  const ts = Number(tsParam)
  if (isNaN(ts)) {
    return NextResponse.redirect(new URL('/newsletter/error?reason=invalid-token', req.url))
  }

  // Check 48-hour expiry
  if (Date.now() - ts > FORTY_EIGHT_HOURS_MS) {
    return NextResponse.redirect(new URL('/newsletter/error?reason=expired', req.url))
  }

  const secret = process.env.NEWSLETTER_SECRET
  if (!secret) {
    console.error('NEWSLETTER_SECRET not configured')
    return NextResponse.redirect(new URL('/newsletter/error?reason=server-error', req.url))
  }

  // Verify HMAC signature
  const valid = await verifySignature(email, ts, sig, secret)
  if (!valid) {
    return NextResponse.redirect(new URL('/newsletter/error?reason=invalid-token', req.url))
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

  // Generate HMAC-signed unsubscribe link (no expiry)
  const unsubSig = await signPayload(`unsubscribe|${email}`, secret)
  const unsubUrl =
    `https://silentsuite.io/api/newsletter/unsubscribe?email=${encodeURIComponent(email)}&sig=${unsubSig}`

  // Register confirmed subscriber in billing API contacts table (B3 fix)
  const billingApiUrl = process.env.BILLING_API_URL || 'https://api.silentsuite.io'
  try {
    await fetch(`${billingApiUrl}/newsletter/register-confirmed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.NEWSLETTER_SECRET ? { Authorization: `Bearer ${process.env.NEWSLETTER_SECRET}` } : {}),
      },
      body: JSON.stringify({ email, source: 'newsletter_landing' }),
    })
  } catch (err) {
    console.error('Failed to register contact in billing API:', err)
    // Don't block the confirmation flow
  }

  // Send the welcome email
  try {
    const { error: sendError } = await getResend().emails.send({
      from: 'SilentSuite <noreply@silentsuite.io>',
      to: email,
      subject: 'Welcome to SilentSuite updates',
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>, <mailto:unsubscribe@silentsuite.io>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
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
<tr><td style="background: linear-gradient(160deg, #0a1018 0%, #052e16 40%, #0a1018 100%); border-radius: 12px 12px 0 0; padding: 48px 32px 40px; text-align: center;">
<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 auto 24px;">
<tr><td style="text-align: center; background-color: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.2); border-radius: 16px; padding: 14px; line-height: 0;">
<img src="https://silentsuite.io/email/shield.png" width="48" height="48" alt="Shield" style="display: block; border: 0;" />
</td></tr>
</table>
<h1 style="margin: 0 0 10px; font-size: 26px; font-weight: 700; color: #f8fafc; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; letter-spacing: -0.5px; line-height: 1.3;">You're in!</h1>
<p style="margin: 0; font-size: 15px; color: #94a3b8; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.5;">Welcome to the SilentSuite newsletter</p>
</td></tr>
</table>
</td></tr>

<!-- Body -->
<tr><td style="background-color: #0f1729; border-radius: 0 0 12px 12px; padding: 36px 36px 40px; border-top: 1px solid #1a2640;">
<p style="margin: 0 0 18px; font-size: 15px; line-height: 1.7; color: #94a3b8; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">Thanks for confirming your subscription. SilentSuite is an end-to-end encrypted calendar, contacts, and tasks sync service. Your data is encrypted on your device before it ever leaves. Not even we can read it.</p>

<h2 style="margin: 0 0 16px; font-size: 18px; font-weight: 600; color: #e2e8f0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; letter-spacing: -0.2px;">Here's what you get</h2>

<p style="margin: 0 0 18px; font-size: 15px; line-height: 1.7; color: #94a3b8; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
• Calendar, contacts, and tasks sync across all your devices<br>
• End-to-end encryption with zero-knowledge architecture<br>
• Web app, Android app, and CalDAV bridge<br>
• Open-source server you can self-host
</p>

<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 28px auto;" align="center"><tr><td style="text-align: center; background: linear-gradient(135deg, #10b981 0%, #059669 100%); border-radius: 10px; mso-padding-alt: 0; box-shadow: 0 4px 14px rgba(16, 185, 129, 0.25);"><a href="https://app.silentsuite.io/signup" style="display: inline-block; padding: 16px 40px; color: #ffffff; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 16px; font-weight: 600; text-decoration: none; letter-spacing: 0.3px;">Create your account</a></td></tr></table>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 32px 0;"><tr><td style="height: 1px; background: linear-gradient(to right, transparent, #1e293b, transparent);"></td></tr></table>

<p style="margin: 0 0 18px; font-size: 15px; line-height: 1.7; color: #94a3b8; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">We'll send you occasional product updates and feature announcements. No spam, ever.</p>
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
<p style="margin: 0; font-size: 11px; color: #475569; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
You received this email because you confirmed your subscription on silentsuite.io.
<br><a href="${unsubUrl}" style="color: #475569; text-decoration: underline; text-underline-offset: 2px; text-decoration-color: #334155;">Unsubscribe</a>
</p>
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
      return NextResponse.redirect(new URL('/newsletter/error?reason=server-error', req.url))
    }

    return NextResponse.redirect(new URL('/newsletter/confirmed', req.url))
  } catch (err) {
    console.error('Confirmation API error:', err)
    return NextResponse.redirect(new URL('/newsletter/error?reason=server-error', req.url))
  }
}
