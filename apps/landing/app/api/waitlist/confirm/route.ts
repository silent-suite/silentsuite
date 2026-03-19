import { NextRequest, NextResponse } from 'next/server'
import { getCloudflareContext } from '@opennextjs/cloudflare'

// Simple rate limiter: 10 confirmation attempts per IP per 15 minutes
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

export async function GET(req: NextRequest) {
  // Rate limiting
  const ip = req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'

  if (isRateLimited(ip)) {
    return NextResponse.redirect(new URL('/waitlist/error?reason=rate-limited', req.url))
  }

  const token = req.nextUrl.searchParams.get('token')

  if (!token) {
    return NextResponse.redirect(new URL('/waitlist/error?reason=missing-token', req.url))
  }

  // Basic token format validation (prevent injection)
  if (typeof token !== 'string' || token.length > 200 || !/^[a-zA-Z0-9_-]+$/.test(token)) {
    return NextResponse.redirect(new URL('/waitlist/error?reason=invalid-token', req.url))
  }

  // Access the webhook URL from Cloudflare Worker env (supports secrets + vars)
  let webhookUrl = process.env.N8N_CONFIRM_WEBHOOK_URL || ''

  try {
    const { env } = await getCloudflareContext()
    webhookUrl = (env as Record<string, string>).N8N_CONFIRM_WEBHOOK_URL || webhookUrl
  } catch {
    // Fallback to process.env if not in Cloudflare context (e.g., local dev)
  }

  if (!webhookUrl) {
    console.error('N8N_CONFIRM_WEBHOOK_URL not configured')
    return NextResponse.redirect(new URL('/waitlist/error?reason=server-error', req.url))
  }

  try {
    // Forward confirmation token to n8n for processing
    // n8n will verify the token and mark the Formbricks entry as confirmed
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })

    if (!res.ok) {
      const body = await res.text()
      console.error('n8n confirmation error:', body)
      return NextResponse.redirect(new URL('/waitlist/error?reason=invalid-token', req.url))
    }

    return NextResponse.redirect(new URL('/waitlist/confirmed', req.url))
  } catch (err) {
    console.error('Confirmation API error:', err)
    return NextResponse.redirect(new URL('/waitlist/error?reason=server-error', req.url))
  }
}
