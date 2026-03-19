import { NextResponse } from 'next/server'

const HEX_PUBKEY = 'ebf49c489b96ca682ccb36b861ec3d154afda55a2bf11cdb2b5595b337c4c9d2'

const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
]

const data = {
  names: {
    '_': HEX_PUBKEY,
    'timo': HEX_PUBKEY,
  },
  relays: {
    [HEX_PUBKEY]: RELAYS,
  },
}

export async function GET() {
  return NextResponse.json(data, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Cache-Control': 'public, max-age=3600',
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
