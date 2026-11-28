// Writes the fixture bundle that WebAppActivityRuntimeTest serves in place of the
// real web app: ../assets/webapp/manifest.json and the files it names.
//
// Run by hand after changing a page or the probe script; CI never runs it:
//   node android/app/src/androidTest/webapp-fixture/generate.mjs
//
// The format and the page policy are the real bundle's (apps/web/android-bundle).
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentSecurityPolicy, inlineScriptHashes } from '../../../../../apps/web/android-bundle/bundle-contract.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, '..', 'assets', 'webapp')

const connectOrigins = ['https://server.silentsuite.io', 'https://api.silentsuite.io']

// The policy lists this script's hash, so it runs.
const hashedInline = '<script>window.fixtureHashedInline = true</script>'
// The policy does not list this one, so it must not run.
const unhashedInline = '<script>window.fixtureUnhashedInline = true</script>'

function page(title) {
  const head = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n${hashedInline}\n`
  const rest = `<script src="/probe.js"></script>\n</head>\n<body>\n<p>${title}</p>\n</body>\n</html>\n`
  return {
    html: `${head}${unhashedInline}\n${rest}`,
    scriptHashes: inlineScriptHashes(`${head}${rest}`),
  }
}

const sources = [
  { urlPath: '/login/', extension: '.html', contentType: 'text/html', ...page('fixture start') },
  { urlPath: '/calendar/', extension: '.html', contentType: 'text/html', ...page('fixture second') },
  { urlPath: '/404.html', extension: '.html', contentType: 'text/html', ...page('fixture not found') },
  { urlPath: '/probe.js', extension: '.js', contentType: 'text/javascript', content: readFileSync(path.join(here, 'probe.js')) },
]

rmSync(outDir, { recursive: true, force: true })
mkdirSync(path.join(outDir, 'files'), { recursive: true })

const files = {}
for (const source of sources) {
  const content = source.content ?? Buffer.from(source.html, 'utf8')
  const sha256 = createHash('sha256').update(content).digest('hex')
  const asset = `files/${sha256}${source.extension}`
  const entry = { asset, contentType: source.contentType, sha256 }
  if (source.html) {
    entry.contentSecurityPolicy = contentSecurityPolicy({
      scriptHashes: source.scriptHashes,
      // As in the real bundle: the sync server also over WebSocket.
      connectSources: [connectOrigins[0], connectOrigins[0].replace('https://', 'wss://'), connectOrigins[1]],
    })
  }
  writeFileSync(path.join(outDir, asset), content)
  files[source.urlPath] = entry
}

const manifest = {
  schemaVersion: 1,
  origin: 'https://app.silentsuite.io',
  startPath: '/login/',
  notFoundPath: '/404.html',
  syncServerOrigin: 'https://server.silentsuite.io',
  connectOrigins,
  files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
}
writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
