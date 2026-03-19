import { NextResponse } from 'next/server'

const securityTxt = `Contact: mailto:info@silentsuite.io
Expires: 2027-03-12T00:00:00.000Z
Preferred-Languages: en, de
Canonical: https://silentsuite.io/.well-known/security.txt
Policy: https://github.com/silent-suite
`

export async function GET() {
  return new NextResponse(securityTxt, {
    headers: {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Cache-Control': 'public, max-age=86400',
    },
  })
}

export async function OPTIONS() {
  return new NextResponse(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })
}
