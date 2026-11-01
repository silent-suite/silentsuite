# Bridge desktop T0 probe (non-product)

`probe.py` is a throwaway capability test for #171. It is not part of the
Bridge package, the release builds or the pytest suite (pytest only collects
`test_*.py`). It imports nothing from `silentsuite_bridge`.

It opens one Qt WebEngine window (PySide6, pinned in `requirements.txt`)
against two synthetic loopback servers on ephemeral ports and checks, from
the servers' own request logs, that the candidate desktop policy stops
disallowed navigation, popups, redirects, frames and subresources before any
request reaches them. Execution checks use canary requests. It also checks
that page script sees no application bridge (no Qt WebChannel transport, no
`window.pywebview`, no `chrome.webview`), that the profile is off-the-record
in practice, and that a random synthetic marker written to cookies, web
storage, IndexedDB, a cached page and a posted password field is not found on
disk afterwards. Downloads must be cancelled.

A blocked outcome only counts with positive evidence that the attempt really
happened:
- every scripted step reports `ran` to the allowed server before it acts, and
  reports any thrown error
- each blocked navigation, frame, redirect, subresource or app-initiated load
  must also appear as a rejection in `acceptNavigationRequest` or as a block
  in the request interceptor, tagged with its own step
- `window.open` must return `null` to the page
- one step turns `JavascriptCanOpenWindows` on, so the popup reaches Qt's
  `createWindow`/`newWindowRequested` handling instead of being refused
  earlier by Chromium

Storage writes are read back in the page, and the server checks that its
cookie came back. The disk scan has its own positive control: a second
random marker, written by the probe in ASCII and UTF-16LE, must be found.
Any file the scan had to skip fails the run instead of being treated as
clean.

Known limits:
- synthetic `click()` on a `target=_blank` link carries no user gesture, so
  those two steps prove only that the click ran and nothing was requested
- `javascript:` URLs are recorded but don't gate
- a TCP preconnect that sends no HTTP request would not show in the server
  logs

It runs only in `.github/workflows/test-bridge-desktop-probe.yml` on hosted
runners, once from source and once frozen with PyInstaller. Do not run it on
a workstation as a substitute for that evidence.

Exit codes: `0` pass, `1` gate failed or timed out, `2` prerequisite missing,
anything else means it crashed before reporting (the JSON file keeps the last
stage reached).

What it does not prove: product navigation code, the real dashboard, the
settings API, installers, autostart, signed or notarized builds, or behaviour
on machines without developer tools.
