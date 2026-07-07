# Golden item-format interop corpus

This directory is the **test bed for SilentSuite's item-format contract**: the
ICS (RFC 5545) and vCard 3.0 (RFC 2426) dialect that calendar/contact items
must survive when they move between surfaces — web app (`packages/core`
parsers), the DAV bridge (`bridge/`, vobject-based), external CalDAV/CardDAV
clients, and (in a future slice) the Android parser stack.

Every fixture is a complete, synthetic, privacy-safe document with
RFC-mandated CRLF line endings (pinned by the local `.gitattributes`).
`manifest.json` records the *logical* (unescaped) values each consumer must
recover, so all test suites assert against a single source of expectations.

## Consumers

| Suite | Location | What it checks |
| --- | --- | --- |
| core Vitest | `packages/core/src/utils/item-format-fixtures.test.ts` | Parse each fixture, assert manifest expectations, then generate → re-parse round-trip preserves all contract fields |
| bridge pytest | `bridge/tests/test_item_format_fixtures.py` | Parse the same files with `vobject` (the bridge's production parser) and assert the same manifest expectations |
| Android | deferred follow-up | ical4android/vcard4android already keep their own resources under `android/*/src/test/resources/`; a future lane can consume this corpus too |

The server is deliberately **not** a consumer: item payloads are end-to-end
encrypted and the zero-knowledge server never parses plaintext content.

## Coverage

- **CATEGORIES** (labels) on VEVENT, VTODO, and vCard, including values with
  escaped commas, semicolons, and backslashes (`Travel\, Inc.`, `Semi\;colon`,
  `Back\\slash`).
- **TZID** parameters on DTSTART/DTEND plus a real VTIMEZONE definition
  (`Europe/Vienna`), so timezone-aware consumers can resolve local times and
  UTC offsets.
- **Recurrence**: RRULE and multi-value EXDATE with TZID.
- **Text escaping** in SUMMARY/DESCRIPTION/LOCATION/NOTE/N (`\n`, `\,`, `\;`,
  `\\`), RFC 5545 line folding/unfolding, and non-ASCII UTF-8 text.
- **vCard structured values**: N with escaped delimiters, ORG, and
  `TEL;VALUE=uri` (`tel:` URI) alongside plain TEL.

## Manifest schema

```jsonc
{
  "fixtures": [
    {
      "path": "ics/… | vcf/…",   // repo path relative to this directory
      "kind": "vevent | vtodo | vcard",
      "covers": ["…"],            // informal coverage tags
      "expected": { … }           // logical values; keys are consumed strictly
    }
  ]
}
```

`expected` keys are handled by an explicit switch in every consumer, and an
unknown key **fails the suite** — so adding a new expectation forces every
consumer to implement (or explicitly waive) it. Keys asserted only where they
make sense: `utcOffsetMinutes` is timezone math and is asserted by the bridge
(vobject resolves VTIMEZONE); the core parser treats date-times as opaque
strings plus a TZID parameter, so it asserts `tzid`/`*Local` instead.
`telUri` pins the raw on-the-wire form; `telNumber` pins the normalized value
the core parser exposes.

## Adding a fixture

1. Add a synthetic `.ics`/`.vcf` file here (CRLF line endings, no real
   personal data, fold lines at ≤75 octets).
2. Add a manifest entry with its logical expected values.
3. Run `pnpm test` in `packages/core` and `python -m pytest tests/test_item_format_fixtures.py`
   in `bridge/` (CI runs both). The corpus-completeness tests fail if a file
   and its manifest entry don't match one-to-one.
