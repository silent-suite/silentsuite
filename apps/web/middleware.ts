import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isSelfHostedBuild = process.env.NEXT_PUBLIC_SELF_HOSTED === 'true'

  // Hosted builds render /admin as a redirect to the private SaaS dashboard.
  // Self-hosted builds still guard the helper behind an admin session cookie.
  if (isSelfHostedBuild && pathname.startsWith('/admin')) {
    const isAdmin = request.cookies.get('is_admin')?.value

    if (isAdmin !== 'true') {
      const url = request.nextUrl.clone()
      url.pathname = '/calendar'
      return NextResponse.redirect(url)
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/admin', '/admin/:path*'],
}
