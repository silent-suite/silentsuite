import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Protect /admin routes: require is_admin cookie synced by the auth store on login/refresh
  if (pathname.startsWith('/admin')) {
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
