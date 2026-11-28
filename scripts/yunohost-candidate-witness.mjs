#!/usr/bin/env node
// Data witness for the YunoHost candidate CI, using the repo's patched Etebase SDK.
//
//   create --state FILE   owner grant via the admin SSO session, SDK signup, one collection and
//                         one item with >= 200 KiB of random content; writes the state (mode 600)
//   verify --state FILE   SDK login on the native path (no cookie), fetch and download the item,
//                         compare its sha256 with the state, store the fresh auth token
//   write-loop --state FILE ACKS STOP
//                         keep writing small items into the witness collection until the file STOP
//                         exists (failures while the server is down are expected); a write counts
//                         as acknowledged once the server reads it back, and goes to ACKS
//   verify-acks --state FILE ACKS
//                         every acknowledged item from ACKS must still exist with the same content
//
// Environment: DOMAIN (default domain.tld), ADMIN_USER, ADMIN_PASS, OWNER_PASSWORD, and
// NODE_EXTRA_CA_CERTS pointing at the YunoHost CA. Prints check names only, never secrets,
// tokens or UIDs. Exits 1 on the first failed check.

import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const Etebase = createRequire(join(repoRoot, 'packages/core/package.json'))('etebase')
const DOMAIN = process.env.DOMAIN || 'domain.tld'
const ORIGIN = `https://${DOMAIN}`
const SERVER_URL = `${ORIGIN}/`
const COLLECTION_TYPE = 'etebase.vevent'
const CONTENT_BYTES = 256 * 1024

function pass(name) {
  console.log(`PASS ${name}`)
}

function fail(name) {
  console.log(`FAIL ${name}`)
  process.exit(1)
}

async function step(name, action) {
  try {
    const result = await action()
    pass(name)
    return result
  } catch (error) {
    fail(`${name} (${error?.constructor?.name ?? 'error'})`)
  }
}

function https(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: DOMAIN, servername: DOMAIN, port: 443, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.setTimeout(60_000, () => req.destroy(new Error('timeout')))
    req.end(body)
  })
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function writeState(file, state) {
  writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
}

async function adminCookie() {
  const body = new URLSearchParams({ credentials: `${process.env.ADMIN_USER}:${process.env.ADMIN_PASS}` }).toString()
  const res = await https('POST', '/yunohost/portalapi/login', { 'Content-Type': 'application/x-www-form-urlencoded' }, body)
  const cookies = (res.headers['set-cookie'] ?? []).map((value) => value.split(';')[0])
  if (res.status !== 200 || !res.body.toString().includes('Logged in') || cookies.length === 0) throw new Error('portal')
  return cookies.join('; ')
}

async function ownerGrant(cookie, username) {
  const body = JSON.stringify({ password: process.env.OWNER_PASSWORD, username })
  const res = await https('POST', '/api/v1/owner/login/', { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie }, body)
  const grant = res.status === 200 ? JSON.parse(res.body.toString()).registration_token : undefined
  if (typeof grant !== 'string' || !grant) throw new Error('grant')
  return grant
}

async function create(file) {
  await Etebase.ready
  const username = `ci-witness-${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('base64url')
  const cookie = await step('portal login as admin', adminCookie)
  const grant = await step('owner login issues a grant', () => ownerGrant(cookie, username))
  const account = await step('SDK signup with the owner grant', () =>
    Etebase.Account.signup({ username, email: `${username}@example.test` }, password, SERVER_URL, { registrationToken: grant }))
  const collectionManager = account.getCollectionManager()
  const collection = await step('create and upload a collection', async () => {
    const created = await collectionManager.create(COLLECTION_TYPE, { name: 'CI witness', mtime: Date.now() }, '')
    await collectionManager.upload(created)
    return created
  })
  const content = randomBytes(CONTENT_BYTES)
  const item = await step('create and upload an item with 256 KiB content', async () => {
    const itemManager = collectionManager.getItemManager(collection)
    const created = await itemManager.create({ type: 'text/calendar', name: 'witness.ics', mtime: Date.now() }, new Uint8Array(content))
    await itemManager.batch([created])
    return created
  })
  writeState(file, {
    username,
    password,
    authToken: account.authToken,
    collectionUid: collection.uid,
    itemUid: item.uid,
    contentSha256: sha256(content),
  })
  pass('state written')
}

async function verify(file) {
  await Etebase.ready
  const state = JSON.parse(readFileSync(file, 'utf8'))
  const account = await step('SDK login on the native path', () => Etebase.Account.login(state.username, state.password, SERVER_URL))
  const collectionManager = account.getCollectionManager()
  const collection = await step('fetch the witness collection', () => collectionManager.fetch(state.collectionUid))
  const content = await step('fetch and download the witness item', async () => {
    const itemManager = collectionManager.getItemManager(collection)
    const item = await itemManager.fetch(state.itemUid)
    if (item.isMissingContent) await itemManager.downloadContent(item)
    return item.getContent()
  })
  if (sha256(Buffer.from(content)) !== state.contentSha256) fail('witness content sha256 matches')
  pass('witness content sha256 matches')
  writeState(file, { ...state, authToken: account.authToken })
  pass('state auth token refreshed')
}

async function writeLoop(file, acks, stop) {
  await Etebase.ready
  const state = JSON.parse(readFileSync(file, 'utf8'))
  const account = await step('write loop: SDK login', () => Etebase.Account.login(state.username, state.password, SERVER_URL))
  const collectionManager = account.getCollectionManager()
  const collection = await step('write loop: fetch the witness collection', () => collectionManager.fetch(state.collectionUid))
  const itemManager = collectionManager.getItemManager(collection)
  const deadline = Date.now() + 30 * 60_000
  let acknowledged = 0
  let unconfirmed = 0
  while (!existsSync(stop) && Date.now() < deadline) {
    const content = randomBytes(1024)
    let item
    try {
      item = await itemManager.create({ type: 'text/calendar', name: 'loop.ics', mtime: Date.now() }, new Uint8Array(content))
      await itemManager.batch([item])
    } catch {
      // The server is stopped during part of the upgrade: a refused write is fine.
      item = undefined
    }
    if (item) {
      // Acknowledged means the SilentSuite server reads it back. While YunoHost has the app
      // removed during a rollback, SSOwat answers its URLs with a portal redirect, which the
      // SDK follows and does not report as an error; such a write is "unconfirmed".
      try {
        await itemManager.fetch(item.uid)
        appendFileSync(acks, `${item.uid} ${sha256(content)} ${Date.now()}\n`, { mode: 0o600 })
        acknowledged += 1
      } catch {
        unconfirmed += 1
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  console.log(`INFO write loop: ${acknowledged} acknowledged writes, ${unconfirmed} unconfirmed`)
}

async function verifyAcks(file, acks) {
  await Etebase.ready
  const state = JSON.parse(readFileSync(file, 'utf8'))
  const lines = existsSync(acks) ? readFileSync(acks, 'utf8').trim().split('\n').filter(Boolean) : []
  if (lines.length === 0) fail('write loop acknowledged at least one write')
  pass('write loop acknowledged at least one write')
  const account = await step('acks: SDK login', () => Etebase.Account.login(state.username, state.password, SERVER_URL))
  const collectionManager = account.getCollectionManager()
  const collection = await step('acks: fetch the witness collection', () => collectionManager.fetch(state.collectionUid))
  const itemManager = collectionManager.getItemManager(collection)
  // Times and counts only: never print UIDs.
  const missing = []
  for (const [index, line] of lines.entries()) {
    const [uid, digest, ackedAt] = line.split(' ')
    let item
    try {
      item = await itemManager.fetch(uid)
    } catch (error) {
      missing.push(`#${index + 1} acked at ${Math.floor(Number(ackedAt) / 1000)} (${error?.constructor?.name ?? 'error'})`)
      continue
    }
    if (item.isMissingContent) await itemManager.downloadContent(item)
    if (sha256(Buffer.from(await item.getContent())) !== digest) missing.push(`#${index + 1} content differs`)
  }
  if (missing.length) {
    console.log(`INFO ${missing.length} of ${lines.length} acknowledged writes missing: ${missing.join('; ')}`)
    fail('every acknowledged write survived')
  }
  pass(`every acknowledged write survived (${lines.length})`)
}

const [command, flag, file, ...rest] = process.argv.slice(2)
const commands = { create: 0, verify: 0, 'write-loop': 2, 'verify-acks': 1 }
if (!(command in commands) || flag !== '--state' || !file || rest.length !== commands[command]) {
  console.error('usage: yunohost-candidate-witness.mjs create|verify --state FILE | write-loop --state FILE ACKS STOP | verify-acks --state FILE ACKS')
  process.exit(2)
}
if (command === 'create') await create(file)
else if (command === 'verify') await verify(file)
else if (command === 'write-loop') await writeLoop(file, rest[0], rest[1])
else await verifyAcks(file, rest[0])
// The SDK may leave sockets or timers behind; the result is already printed.
process.exit(0)
