# Security policy

## Reporting a vulnerability

Email <info@silentsuite.io>. Please don't open a public GitHub issue, discussion or pull request for a security or privacy problem.

You can encrypt your report with the PGP key at <https://silentsuite.io/.well-known/security.asc>. English and German are both fine. The same contact details are published in [security.txt](https://silentsuite.io/.well-known/security.txt).

This covers the code in this repository (server, web app, Android app, Bridge, self-host files) and the hosted service at silentsuite.io.

A useful report includes:

- the affected part (hosted service, web app, Android, Bridge, server or self-host) and the version, release tag or commit
- what an attacker could do, and what they would need first (an account, a device, network position, a malicious server)
- steps to reproduce, and a proof of concept if you have one
- your platform, browser or DAV client, where it matters

Use test accounts and data you own. Don't include passwords, recovery phrases, API keys or anyone's real calendar, contact or task content in the report. If a problem exposes someone else's data, stop there and describe what you saw without copying it.

## What happens next

A maintainer will read your report and may come back with questions. There is no fixed response time and no bug bounty.

Fixes are made on `main` and ship in a later release. Please give the project a reasonable chance to release a fix before you publish details.

## Supported versions

SilentSuite is in public beta. Reports are most useful against the [latest release](https://github.com/silent-suite/silentsuite/releases/latest), the current `main` branch or the hosted service.

## More context

The [security page](https://silentsuite.io/security) describes the threat model and known limitations. SilentSuite has not yet had an independent third-party security audit.
