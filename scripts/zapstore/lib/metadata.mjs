// Store metadata: trusted template -> exact-release zsp configuration.
//
// The template holds copy and repository-relative media paths only. Media bytes
// are read from the protected checkout, hashed and copied next to the generated
// config; the changelog is read from the release's own source commit by version
// code. The generated config is JSON, which the YAML parser used by zsp accepts,
// so no YAML emitter is needed.

import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export const APPROVED_SCREENSHOTS = [
  '1-encrypted-sync.png',
  '2-cross-platform-sync.png',
  '3-calendar-contacts-tasks.png',
  '4-collections-sharing.png',
  '5-import-export.png',
  '6-encryption-fingerprint.png',
]

const REPO_RELATIVE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._\/-]+$/

export function loadTemplate(path) {
  const template = JSON.parse(readFileSync(path, 'utf8'))
  const required = ['package', 'repository', 'pubkey', 'pubkeyHex', 'channel', 'expectedCertificateSha256', 'name', 'summary', 'description', 'tags', 'license', 'website', 'icon', 'images', 'changelogDirectory']
  for (const key of required) if (template[key] === undefined || template[key] === '') throw new Error(`template is missing ${key}`)
  for (const path of [template.icon, template.changelogDirectory, ...template.images]) {
    if (!REPO_RELATIVE.test(path)) throw new Error(`template path is not repository-relative: ${path}`)
  }
  const names = template.images.map((p) => basename(p))
  if (JSON.stringify(names) !== JSON.stringify(APPROVED_SCREENSHOTS)) throw new Error('template screenshots are not the six approved names in order')
  if (template.channel !== 'main') throw new Error('template channel must stay main unless a new channel policy is approved')
  for (const key of ['repository', 'website']) if (!/^https:\/\//.test(template[key])) throw new Error(`template ${key} must be https`)
  const text = JSON.stringify(template)
  if (/raw\.githubusercontent\.com|\/releases\/download\//.test(text)) throw new Error('template must not carry release or raw-content URLs')
  return template
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// Copies icon and screenshots from the protected checkout and records hashes.
export function stageMedia({ template, sourceRoot, outDir }) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const stage = (relative) => {
    const from = resolve(sourceRoot, relative)
    const to = join(outDir, basename(relative))
    copyFileSync(from, to)
    return { path: relative, localPath: to, sha256: sha256File(to), size: readFileSync(to).length }
  }
  return { icon: stage(template.icon), images: template.images.map(stage) }
}

// Release notes are the reviewed text for exactly this version code at exactly
// the release's source commit. `readAtSource` is `git show <sha>:<path>`.
export function resolveChangelog({ template, versionCode, sourceSha, readAtSource, outDir }) {
  if (!Number.isInteger(versionCode) || versionCode <= 0) throw new Error('versionCode must be a positive integer')
  const relative = `${template.changelogDirectory}/${versionCode}.txt`
  const text = readAtSource(sourceSha, relative)
  if (typeof text !== 'string' || text.trim() === '') throw new Error(`changelog ${relative} is missing or empty at ${sourceSha}`)
  const localPath = join(outDir, `${versionCode}.txt`)
  writeFileSync(localPath, text, { mode: 0o600 })
  return { path: relative, sourceSha, localPath, sha256: createHash('sha256').update(text).digest('hex'), text }
}

export function generateConfig({ template, apkPath, media, changelog, outPath }) {
  const config = {
    repository: template.repository,
    release_source: apkPath,
    pubkey: template.pubkey,
    name: template.name,
    summary: template.summary,
    description: template.description,
    tags: template.tags,
    license: template.license,
    website: template.website,
    icon: media.icon.localPath,
    images: media.images.map((image) => image.localPath),
    release_notes: changelog.localPath,
  }
  const text = JSON.stringify(config, null, 2) + '\n'
  if (outPath) writeFileSync(outPath, text, { mode: 0o600 })
  return { config, text }
}

// Minimal reader for the committed zapstore.yaml so tests can prove the template
// copy is byte-identical to the file the store already shows.
export function parseZapstoreYaml(text) {
  const lines = text.split('\n')
  const result = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const scalar = /^([a-z_]+):\s*(.*)$/.exec(line)
    if (!scalar) { i += 1; continue }
    const [, key, rest] = scalar
    if (rest === '|') {
      const block = []
      i += 1
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i] === '')) { block.push(lines[i].replace(/^ {2}/, '')); i += 1 }
      while (block.length && block[block.length - 1] === '') block.pop()
      result[key] = block.join('\n') + '\n'
      continue
    }
    if (rest === '') {
      const list = []
      i += 1
      while (i < lines.length && /^  - /.test(lines[i])) { list.push(lines[i].slice(4)); i += 1 }
      result[key] = list
      continue
    }
    result[key] = rest
    i += 1
  }
  return result
}
