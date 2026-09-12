// The official publisher: pinned binary, exact invocation, guarded environment.

export const ZSP = {
  version: '0.4.17',
  url: 'https://github.com/zapstore/zsp/releases/download/v0.4.17/zsp-0.4.17-linux-amd64',
  sha256: '3f241da6a5dc7a85fe851d3b42b77790b651bd36c7029382a701262bda832d20',
}

// Flags, in order:
//   --json --quiet             machine output, no prompts
//   --skip-preview             no browser preview
//   --skip-metadata            never merge external metadata over the trusted template
//   --no-compress              preserve approved icon/screenshot bytes
//   --skip-certificate-linking never emit an identity-link (kind 30509) event
//   --commit <sha>             reproducible-build pointer
//   --channel main             existing relay channel
// Unsigned mode adds --offline (events to stdout, nothing uploaded). Live mode
// adds --overwrite-release. Upstream zsp 0.4.17 does not treat that flag as a
// local-cache bypass: CheckExistingRelease reads the existing kind-30063
// created_at from the relay and supplies it as MinReleaseTimestamp so the
// replacement clears NIP-33. This lane still decides *whether* a live run is
// allowed; the flag only makes a permitted replacement relay-visible.
export function zspArgs({ configPath, commit, channel = 'main', mode }) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('zsp --commit requires a 40-hex commit')
  if (channel !== 'main') throw new Error('channel must stay main unless a new channel policy is approved')
  if (typeof configPath !== 'string' || configPath === '') throw new Error('configPath is required')
  const args = ['publish', '--json', '--quiet', '--skip-preview', '--skip-metadata', '--no-compress', '--skip-certificate-linking', '--commit', commit, '--channel', channel]
  if (mode === 'unsigned') args.push('--offline')
  else if (mode === 'live') args.push('--overwrite-release')
  else throw new Error(`unknown zsp mode ${String(mode)}`)
  args.push(configPath)
  return args
}

// Unsigned mode signs nothing: SIGN_WITH is the public npub, so zsp emits
// unsigned events with the correct pubkey. Live mode requires a bunker URL.
export function zspEnv({ mode, npub, signWith, xdgConfigHome }) {
  const env = { HOME: process.env.HOME ?? '/tmp', PATH: process.env.PATH ?? '/usr/bin:/bin', XDG_CONFIG_HOME: xdgConfigHome }
  if (typeof xdgConfigHome !== 'string' || xdgConfigHome === '') throw new Error('XDG_CONFIG_HOME must be an explicit job-scoped directory')
  if (mode === 'unsigned') {
    if (!/^npub1[02-9ac-hj-np-z]{58}$/.test(npub ?? '')) throw new Error('unsigned mode requires the publisher npub')
    env.SIGN_WITH = npub
    return env
  }
  if (mode === 'live') {
    if (typeof signWith !== 'string' || signWith === '') throw new Error('ZAPSTORE_SIGN_WITH is missing; refusing to publish')
    if (!signWith.startsWith('bunker://')) throw new Error('ZAPSTORE_SIGN_WITH must be a bunker:// URL; private keys are never accepted')
    env.SIGN_WITH = signWith
    return env
  }
  throw new Error(`unknown zsp mode ${String(mode)}`)
}

export function parseEventsJsonl(text) {
  const events = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let parsed
    try { parsed = JSON.parse(line) } catch { throw new Error('zsp produced a non-JSON line on stdout') }
    if (parsed && typeof parsed === 'object' && Number.isInteger(parsed.kind)) events.push(parsed)
  }
  return events
}

// Identity facts extracted by the official parser (the unsigned 3063 event).
export function apkFactsFromEvent(apkEvent) {
  const get = (name) => (apkEvent.tags.find((t) => t[0] === name) ?? [])[1]
  return {
    packageId: get('i'),
    version: get('version'),
    versionCode: Number(get('version_code')),
    sha256: get('x'),
    size: Number(get('size')),
    certificateSha256: get('apk_certificate_hash'),
    filename: get('filename'),
    commit: get('commit'),
  }
}

export function requireApkIdentity(facts, { packageId, version, versionCode, sha256, size, certificateSha256, filename, commit }) {
  const problems = []
  if (!Number.isInteger(versionCode) || versionCode <= 0) problems.push('expected versionCode is missing')
  if (facts.packageId !== packageId) problems.push(`package ${facts.packageId} != ${packageId}`)
  if (facts.version !== version) problems.push(`version ${facts.version} != ${version}`)
  if (!Number.isInteger(facts.versionCode) || facts.versionCode !== versionCode) problems.push(`version_code ${facts.versionCode} != ${versionCode}`)
  if (facts.sha256 !== sha256) problems.push('APK hash mismatch')
  if (facts.size !== size) problems.push('APK size mismatch')
  if (facts.certificateSha256 !== certificateSha256) problems.push('certificate is not the direct-release certificate')
  if (facts.filename !== filename) problems.push(`filename ${facts.filename} != ${filename}`)
  if (facts.commit !== commit) problems.push('commit tag mismatch')
  if (problems.length) throw new Error(`APK identity check failed: ${problems.join('; ')}`)
  return true
}
