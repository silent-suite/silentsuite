// Parses `apksigner verify --print-certs -v` output and enforces that the APK
// actually verifies (not merely that a certificate can be read out of it) and
// that every signer is the expected direct-release certificate.

export function parseApksignerOutput(text) {
  const lines = text.split(/\r?\n/)
  const certs = []
  const schemes = {}
  let verifies = false
  for (const raw of lines) {
    const line = raw.trim()
    if (line === 'Verifies') verifies = true
    const scheme = /^Verified using (v\d)(?:\.\d)? scheme \([^)]*\): (true|false)$/.exec(line)
    if (scheme) schemes[scheme[1]] = scheme[2] === 'true'
    const cert = /^Signer #(\d+) certificate SHA-256 digest: ([0-9a-f]{64})$/.exec(line)
    if (cert) certs.push({ signer: Number(cert[1]), sha256: cert[2] })
  }
  return { verifies, schemes, certs, hasError: /^ERROR:|DOES NOT VERIFY/m.test(text) }
}

export function requireSignedBy(parsed, expectedCertSha256) {
  if (parsed.hasError || !parsed.verifies) throw new Error('apksigner did not report "Verifies" for the APK')
  if (!(parsed.schemes.v2 || parsed.schemes.v3)) throw new Error('APK verified with neither v2 nor v3 signature scheme')
  if (parsed.certs.length === 0) throw new Error('apksigner reported no signer certificates')
  const foreign = parsed.certs.filter((cert) => cert.sha256 !== expectedCertSha256)
  if (foreign.length) throw new Error(`APK carries a signer that is not the direct-release certificate: signer #${foreign.map((c) => c.signer).join(', #')}`)
  return true
}
