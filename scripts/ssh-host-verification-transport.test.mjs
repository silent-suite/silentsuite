/**
 * Behavioral proof of the pinned SSH transport's server verification.
 *
 * Runs the official drone-ssh 1.8.2 release binary - the exact binary the
 * pinned appleboy/ssh-action entrypoint downloads - against an ephemeral
 * loopback sshd with synthetic keys generated for this run. No production
 * host, credential, or command is involved.
 *
 * What this proves: with a fingerprint supplied, the transport refuses a
 * server presenting a different host key before running the command, and
 * accepts the matching key; with an empty fingerprint the same transport
 * silently skips verification, which is why the runner-side preflight is
 * mandatory. What this does not prove: which key production presents, or that
 * the provisioned secret matches it. That remains a custody duty.
 *
 * Prerequisites are sshd, ssh-keygen, curl and release download access on
 * linux/x64. Without them the proof is skipped with the exact blocker unless
 * SSH_TRANSPORT_PROOF=required, which CI sets so the proof cannot silently
 * disappear.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(path.resolve('apps/web/package.json'))
const { parseDocument } = require('yaml')
const workflowPath = path.resolve('.github/workflows/deploy-web.yml')
const pinnedAction = 'appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2'
// The pinned action's entrypoint.sh defaults DRONE_SSH_VERSION to 1.8.2 and
// downloads this release asset. The digest matches both the release
// checksums.txt entry and the GitHub release-asset digest.
const droneVersion = '1.8.2'
const droneAsset = `drone-ssh-${droneVersion}-linux-amd64`
const droneSha256 = '1e10a9972eef167d9ddbc39e1ba80f7d44a011b4a6bc4f6149434154d9b6bb24'
const droneUrl = `https://github.com/appleboy/drone-ssh/releases/download/v${droneVersion}/${droneAsset}`
const preflightName = 'Require protected SSH host-key fingerprint before final authorization'
const required = process.env.SSH_TRANSPORT_PROOF === 'required'
const sshdPath = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((candidate) => existsSync(candidate))
const user = userInfo().username

const document = parseDocument(readFileSync(workflowPath, 'utf8'), { uniqueKeys: true })
assert.equal(document.errors.length, 0)
const deploySteps = document.toJS().jobs.deploy.steps
const ssh = deploySteps.find((step) => step.name === 'Deploy via SSH')
const preflight = deploySteps.find((step) => step.name === preflightName)

function blocker() {
  if (process.platform !== 'linux' || process.arch !== 'x64') return `no checksum-pinned drone-ssh asset for ${process.platform}/${process.arch}`
  if (!sshdPath) return 'sshd is not installed'
  if (spawnSync('sh', ['-c', 'command -v ssh-keygen >/dev/null && command -v curl >/dev/null']).status !== 0) return 'ssh-keygen or curl is not installed'
  return null
}

function fetchDrone(directory) {
  const cached = process.env.DRONE_SSH_PROOF_BIN
  const target = cached && existsSync(cached) ? cached : path.join(directory, droneAsset)
  if (target !== cached) {
    const download = spawnSync('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '3', droneUrl, '--output', target], { encoding: 'utf8' })
    if (download.status !== 0) return { blocked: `drone-ssh release download failed: ${download.stderr.trim()}` }
    chmodSync(target, 0o700)
  }
  // A cached or freshly downloaded binary is only ever executed after this check.
  assert.equal(createHash('sha256').update(readFileSync(target)).digest('hex'), droneSha256, 'drone-ssh binary does not match the pinned release digest')
  const version = spawnSync(target, ['--version'], { encoding: 'utf8' })
  assert.equal(version.status, 0, version.stderr)
  assert.match(`${version.stdout}${version.stderr}`, new RegExp(droneVersion.replaceAll('.', '\\.')))
  return { bin: target }
}

function keygen(file, comment) {
  const result = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

function fingerprintOf(publicKeyFile) {
  const result = spawnSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', publicKeyFile], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.split(' ')[1]
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
  })
}

async function waitForPort(port, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`synthetic sshd exited early (${child.exitCode}): ${child.diagnostics}`)
    const open = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.on('connect', () => { socket.destroy(); resolve(true) })
      socket.on('error', () => resolve(false))
    })
    if (open) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`synthetic sshd did not listen on 127.0.0.1:${port}: ${child.diagnostics}`)
}

async function startSshd(directory, hostKey, port) {
  const config = `${hostKey}.sshd_config`
  writeFileSync(config, [
    `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${hostKey}`, `PidFile ${hostKey}.pid`,
    `AuthorizedKeysFile ${path.join(directory, 'authorized_keys')}`, 'PubkeyAuthentication yes', 'PasswordAuthentication no',
    'KbdInteractiveAuthentication no', 'UsePAM no', 'StrictModes no', `AllowUsers ${user}`, 'LogLevel ERROR', '',
  ].join('\n'))
  const child = spawn(sshdPath, ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'] })
  child.diagnostics = ''
  child.stderr.on('data', (chunk) => { child.diagnostics += chunk.toString() })
  await waitForPort(port, child)
  return child
}

async function stopSshd(child) {
  if (!child || child.exitCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  await exited
}

function runPreflight(value) {
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', String(preflight?.run ?? 'exit 97')], { env: { PATH: process.env.PATH, VPS_SSH_FINGERPRINT: value }, encoding: 'utf8' })
}

test('the workflow hands the pinned transport a protected fingerprint behind the custody preflight', () => {
  assert.equal(ssh.uses, pinnedAction)
  assert.equal(ssh.with.fingerprint, '${{ secrets.VPS_SSH_FINGERPRINT }}')
  assert.ok(preflight, 'missing the fail-closed fingerprint custody preflight')
})

test('pinned drone-ssh rejects a changed server key before the command and accepts the pinned key', async (t) => {
  const reason = blocker()
  if (reason) {
    if (required) assert.fail(`SSH transport proof is required but blocked: ${reason}`)
    t.skip(reason)
    return
  }
  const directory = mkdtempSync(path.join(tmpdir(), 'ssh-host-verification-'))
  let server
  try {
    const drone = fetchDrone(directory)
    if (drone.blocked) {
      if (required) assert.fail(`SSH transport proof is required but blocked: ${drone.blocked}`)
      t.skip(drone.blocked)
      return
    }
    const pinnedHostKey = path.join(directory, 'host_pinned')
    const changedHostKey = path.join(directory, 'host_changed')
    const clientKey = path.join(directory, 'client')
    keygen(pinnedHostKey, 'synthetic-pinned-host')
    keygen(changedHostKey, 'synthetic-changed-host')
    keygen(clientKey, 'synthetic-client')
    writeFileSync(path.join(directory, 'authorized_keys'), readFileSync(`${clientKey}.pub`), { mode: 0o600 })
    const pinnedFingerprint = fingerprintOf(`${pinnedHostKey}.pub`)
    assert.notEqual(pinnedFingerprint, fingerprintOf(`${changedHostKey}.pub`))
    const port = await freePort()
    const runTransport = (fingerprint, marker) => spawnSync(drone.bin, [], {
      env: {
        PATH: process.env.PATH, HOME: directory, GITHUB: 'true', INPUT_HOST: '127.0.0.1', INPUT_PORT: String(port), INPUT_USERNAME: user,
        INPUT_KEY: readFileSync(clientKey, 'utf8'), INPUT_FINGERPRINT: fingerprint, INPUT_TIMEOUT: '10s', INPUT_COMMAND_TIMEOUT: '30s',
        INPUT_SCRIPT: `printf executed > ${marker}`,
      },
      encoding: 'utf8', timeout: 60_000,
    })

    await t.test('positive control: the pinned synthetic host key is accepted and the benign command runs', async () => {
      // The fingerprint format ssh-keygen emits is exactly what the workflow preflight admits.
      if (preflight) assert.equal(runPreflight(pinnedFingerprint).status, 0)
      server = await startSshd(directory, pinnedHostKey, port)
      const marker = path.join(directory, 'marker-pinned')
      const result = runTransport(pinnedFingerprint, marker)
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}${server.diagnostics}`)
      assert.equal(readFileSync(marker, 'utf8'), 'executed')
      await stopSshd(server)
    })

    await t.test('a changed server key is rejected before the benign command executes', async () => {
      server = await startSshd(directory, changedHostKey, port)
      const marker = path.join(directory, 'marker-changed')
      const result = runTransport(pinnedFingerprint, marker)
      assert.notEqual(result.status, 0, 'the transport must fail when the server key does not match the fingerprint')
      assert.match(`${result.stdout}${result.stderr}`, /fingerprint mismatch/i)
      assert.equal(existsSync(marker), false, 'no command may run on a server whose key did not verify')
    })

    await t.test('an empty fingerprint makes the same transport skip verification, so absent custody must be refused by the preflight', async () => {
      // Same changed-key server and client key: only the fingerprint differs from the rejection above.
      const marker = path.join(directory, 'marker-unverified')
      const result = runTransport('', marker)
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
      assert.equal(readFileSync(marker, 'utf8'), 'executed', 'documented upstream default: an empty fingerprint is not verified')
      assert.ok(preflight, 'missing the fail-closed fingerprint custody preflight')
      const refused = runPreflight('')
      assert.equal(refused.status, 1)
      assert.match(refused.stderr, /Refusing deploy/)
    })
  } finally {
    await stopSshd(server)
    rmSync(directory, { recursive: true, force: true })
  }
})
