// Redaction for anything that might reach a log, summary or issue. Signer
// output is never printed raw: zsp prints connection-request URLs and relay
// details on some paths, and the bunker URL itself carries a secret.

const RULES = [
  [/bunker:\/\/[^\s"'`<>]+/g, 'bunker://[redacted]'],
  [/nostrconnect:\/\/[^\s"'`<>]+/g, 'nostrconnect://[redacted]'],
  [/nsec1[0-9a-z]+/g, '[redacted-nsec]'],
  [/(secret=)[^&\s"'`<>]+/g, '$1[redacted]'],
  [/(SIGN_WITH=)\S+/g, '$1[redacted]'],
  [/(ZAPSTORE_BUNKER_CLIENT_KEY=)\S+/g, '$1[redacted]'],
]

export function redact(text) {
  let out = String(text ?? '')
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out
}

// Structured, size-limited summary of a signer run. Raw stdout/stderr stay in
// the runner's temp directory.
export function summarizeSignerRun({ exitCode, stdoutBytes, stderrBytes, stderrTail }) {
  return {
    exitCode,
    stdoutBytes,
    stderrBytes,
    stderrTail: redact(String(stderrTail ?? '')).slice(-800),
  }
}
