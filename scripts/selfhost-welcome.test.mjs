import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const selfHostBytes = readFileSync(`${repoRoot}self-host/success.html`)
const dockerBytes = readFileSync(`${repoRoot}docker/etebase/success.html`)
const html = selfHostBytes.toString('utf8')
const canonicalMark = readFileSync(`${repoRoot}apps/web/public/logo-mark-dark.svg`, 'utf8')

const INTER_SHA256 = 'c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4'
const fontPattern = /url\("data:font\/woff2;base64,([A-Za-z0-9+/=]+)"\) format\("woff2"\)/g

// Markup without license comments or the embedded font payload, for resource checks.
const stripped = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(fontPattern, 'url(FONT)')
const style = stripped.match(/<style>([\s\S]*?)<\/style>/)[1]
const body = stripped.match(/<body>([\s\S]*?)<\/body>/)[1]

function normalizeMarkup(markup) {
  return markup.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim()
}

function markBody(svg) {
  const start = svg.indexOf('<defs>')
  const end = svg.lastIndexOf('</svg>')
  assert.ok(start >= 0 && end > start, 'mark body not found')
  return normalizeMarkup(svg.slice(start, end))
}

test('self-host and Docker welcome pages are byte-identical', () => {
  assert.equal(Buffer.compare(selfHostBytes, dockerBytes), 0)
  assert.equal(html.includes('SILENTSUITE_EMBED_INTER'), false)
})

test('welcome page inlines the canonical arrows mark geometry as a decoration', () => {
  const marks = body.match(/<svg class="mark"[\s\S]*?<\/svg>/g) ?? []
  assert.equal(marks.length, 1)
  assert.match(marks[0], /viewBox="0 0 210 210"/)
  assert.match(marks[0], /aria-hidden="true"/)
  assert.match(marks[0], /focusable="false"/)
  assert.equal(markBody(marks[0]), markBody(canonicalMark))
  assert.doesNotMatch(style, /filter:\s*grayscale/)
  assert.doesNotMatch(style, /\.mark\s*\{[^}]*filter\s*:/)
})

test('welcome page uses the SilentSuite brand palette', () => {
  assert.match(style, /html\s*\{[^}]*background:\s*#0a1018/)
  assert.match(style, /body\s*\{[^}]*radial-gradient\([^)]*#111b27[^)]*#0a1018/)
  assert.match(style, /\.lockup \.tld\s*\{[^}]*color:\s*#34d399/)
  assert.match(style, /\.actions a\.primary\s*\{[^}]*background:\s*#34d399[^}]*color:\s*#0a1018/)
  assert.match(style, /\.actions a\.primary:hover\s*\{[^}]*background:\s*#10b981/)
  assert.match(style, /\.status\s*\{[^}]*color:\s*#34d399/)
  assert.match(style, /\.lead\s*\{[^}]*color:\s*#94a3b8/)
  for (const accent of ['16, 185, 129', '96, 165, 250', '192, 132, 252', '167, 139, 250']) {
    assert.match(style, new RegExp(`\\.icon-\\d[^{]*\\{[^}]*color:\\s*rgba\\(${accent},`), accent)
  }
})

test('Running status is a plain row with a decorative moving indicator', () => {
  const status = style.match(/\.status\s*\{([^}]*)\}/)[1]
  assert.doesNotMatch(status, /border|padding|background|border-radius/)
  assert.doesNotMatch(stripped, /class="dot"|\.dot\b/)
  assert.match(body, /<p class="status"><span class="status-indicator" aria-hidden="true"><\/span>Running<\/p>/)
  assert.doesNotMatch(stripped, /aria-live|role="status"|role="progressbar"/)

  assert.match(style, /\.status-indicator\s*\{[^}]*border-top-color:\s*#34d399[^}]*border-radius:\s*50%[^}]*animation:\s*status-spin\b[^;]*infinite/)
  assert.match(style, /@keyframes status-spin\s*\{\s*to\s*\{\s*transform:\s*rotate\(360deg\);?\s*\}\s*\}/)
  assert.match(
    style,
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.status-indicator\s*\{\s*animation:\s*none;?\s*\}\s*\}/,
  )
  // Only the status indicator may move.
  assert.deepEqual([...style.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1]), ['status-spin'])
  const animated = [...style.matchAll(/([^{}]+)\{[^}]*\banimation(?:-name)?\s*:\s*([^;}]+)/g)]
    .filter((match) => match[2].trim() !== 'none')
    .map((match) => match[1].trim())
  assert.deepEqual(animated, ['.status-indicator'])
  assert.doesNotMatch(stripped, /transition\s*:/)
})

test('welcome page embeds the signup Inter font with its licenses', () => {
  const fonts = [...html.matchAll(fontPattern)]
  assert.equal(fonts.length, 1)
  const bytes = Buffer.from(fonts[0][1], 'base64')
  assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2')
  assert.equal(createHash('sha256').update(bytes).digest('hex'), INTER_SHA256)
  assert.match(html, /@font-face\s*\{[^}]*font-family:\s*"Inter"/)
  assert.match(style, /body\s*\{[^}]*font-family:\s*"Inter"/)
  assert.match(html, /SIL OPEN FONT LICENSE Version 1\.1/)
  assert.match(html, /The Inter Project Authors/)
  assert.match(html, /ISC License/)
  assert.match(html, /Lucide Contributors/)
})

test('background grid and icons are decorative, non-interactive and static', () => {
  const backdrop = body.match(/<div class="backdrop" aria-hidden="true">([\s\S]*?)<\/div>\s*<header>/)
  assert.ok(backdrop, 'backdrop precedes header and is hidden from assistive technology')
  assert.match(style, /\.backdrop\s*\{[^}]*pointer-events:\s*none/)
  assert.match(style, /\.backdrop\s*\{[^}]*z-index:\s*0/)
  assert.match(style, /header, main\s*\{[^}]*z-index:\s*1/)

  const symbols = [...backdrop[1].matchAll(/<symbol id="([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(symbols, [
    'icon-calendar',
    'icon-square-check-big',
    'icon-users',
    'icon-shield-check',
    'icon-shield',
  ])
  const uses = [...backdrop[1].matchAll(/<use href="#([^"]+)"/g)].map((match) => match[1])
  assert.equal(uses.length, 8)
  for (const id of uses) assert.ok(symbols.includes(id), id)
  assert.match(backdrop[1], /<path d="m9 11 3 3L22 4" \/>/)
  assert.match(backdrop[1], /<path d="M8 2v4" \/>/)

  for (const selector of [/\.backdrop\s*\{([^}]*)\}/, /\.backdrop \.grid\s*\{([^}]*)\}/, /\.icon\s*\{([^}]*)\}/, /\.panel\s*\{([^}]*)\}/]) {
    assert.doesNotMatch(style.match(selector)[1], /animation|transition/, String(selector))
  }
  assert.doesNotMatch(stripped, /\p{Extended_Pictographic}/u)
})

test('welcome page is self-contained and script-free', () => {
  assert.doesNotMatch(stripped, /<script|<link|<img|<iframe|<object|<embed|\bsrc=|@import/i)
  assert.doesNotMatch(stripped, /\son[a-z]+\s*=/i)
  const urlRefs = [...stripped.matchAll(/url\(([^)]*)\)/g)].map((match) => match[1])
  assert.deepEqual(urlRefs.filter((ref) => ref !== 'FONT' && !ref.startsWith('#')), [])
  const urls = [...stripped.matchAll(/https?:\/\/[^"'\s)]+/g)].map((match) => match[0])
  assert.deepEqual(
    [...new Set(urls)].sort(),
    ['http://www.w3.org/2000/svg', 'https://app.silentsuite.io', 'https://docs.silentsuite.io/self-hosting'],
  )
})

test('welcome page keeps the original destinations and connection copy', () => {
  const links = [...body.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((match) => [match[1], match[2]])
  assert.deepEqual(links, [
    ['https://app.silentsuite.io', 'Open Web App'],
    ['https://docs.silentsuite.io/self-hosting', 'Documentation'],
  ])
  assert.match(body, />Running</)
  assert.match(
    body.replace(/\s+/g, ' '),
    /Your self-hosted sync server is up and running\. Connect using the SilentSuite apps or a supported desktop client through the local bridge\./,
  )
})

test('welcome page has a basic accessible structure', () => {
  assert.match(html, /<html lang="en">/)
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1" \/>/)
  assert.match(html, /<title>SilentSuite Sync Server<\/title>/)
  for (const tag of ['header', 'main', 'h1']) {
    assert.equal(body.match(new RegExp(`<${tag}\\b`, 'g'))?.length, 1, tag)
  }
  assert.match(body, /<header>[\s\S]*silentsuite<span class="tld">\.io<\/span>[\s\S]*<\/header>\s*<main\b/)
  assert.match(body, /<main\b[^>]*>[\s\S]*<h1>SilentSuite Sync Server<\/h1>[\s\S]*<\/main>/)
  assert.match(style, /\.actions a:focus-visible\s*\{[^}]*outline:\s*2px solid #34d399/)
  assert.match(style, /\.actions a\s*\{[^}]*min-height:\s*2\.75rem/)
  assert.match(style, /@media \(max-width: 30rem\)/)
  assert.match(style, /@media \(max-height: 36rem\)/)
})
