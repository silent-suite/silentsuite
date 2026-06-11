# Translating SilentSuite

Thank you for helping translate SilentSuite. SilentSuite keeps translation source files in Git so translator contributions remain reviewable, attributable, and easy for maintainers to audit.

This guide is written for people who want to help translate the web app, even if they are not regular code contributors.

## Current Scope

- The web app source locale is English in `apps/web/messages/en.json`.
- Translation contributions currently use GitHub pull requests.
- The first production runtime is still English-only. Maintainers will enable additional languages after there is a real translator/reviewer for that language.
- Android remains on native resources in `android/app/src/main/res/values/strings.xml`.
- Docs translation is deferred until language maintainers exist.
- Do not add locale-prefixed routes, a language switcher, Weblate/Crowdin configuration, Android translations, or docs-site localization unless a maintainer explicitly asks for that scope.

## Quick Start For Translators

1. Open a GitHub issue or comment on an existing translation issue with the language you want to help with.
2. Wait for a maintainer to confirm the locale code and review plan.
3. Copy the English source catalog:

   ```bash
   cp apps/web/messages/en.json apps/web/messages/<locale>.json
   ```

   Examples: `de.json`, `fr.json`, `nl.json`, `pt-BR.json`.

4. Translate message **values** only. Keep the same JSON keys and nesting.
5. Run the validation command:

   ```bash
   pnpm i18n:check
   ```

6. Optional: print a completeness report:

   ```bash
   pnpm i18n:report
   ```

7. Open a pull request and include the locale, reviewer, and validation command output.

## Translator Checklist

Before opening your pull request:

- [ ] I started from `apps/web/messages/en.json`.
- [ ] I translated message values, not JSON keys.
- [ ] I preserved the JSON nesting exactly.
- [ ] I preserved every placeholder exactly, for example `{count}` or `{name}`.
- [ ] I did not translate file paths, commands, URLs, email addresses, or code identifiers.
- [ ] I kept privacy and security claims precise.
- [ ] A fluent human reviewed the translation, especially privacy/security wording.
- [ ] I ran `pnpm i18n:check` successfully.

## Message File Rules

Translation files live in:

```text
apps/web/messages/<locale>.json
```

Use English as the source of truth:

```text
apps/web/messages/en.json
```

Keep stable semantic keys. Translate values only:

```json
{
  "Navigation": {
    "calendar": "Calendar"
  }
}
```

For German, this becomes:

```json
{
  "Navigation": {
    "calendar": "Kalender"
  }
}
```

Do not change the key:

```json
{
  "Navigation": {
    "kalender": "Kalender"
  }
}
```

## Placeholders And ICU Messages

Some messages include placeholders. Preserve placeholder names exactly.

Source:

```json
{
  "itemsRemaining": "{count} items remaining"
}
```

Good translation:

```json
{
  "itemsRemaining": "Noch {count} Einträge übrig"
}
```

Bad translation, because `{count}` was renamed:

```json
{
  "itemsRemaining": "Noch {anzahl} Einträge übrig"
}
```

The validation command checks placeholder names and will fail if a translated message loses or adds placeholders compared with English. It is intentionally lightweight and does not fully parse ICU plural/select syntax, so ask for maintainer review when adding complex ICU messages.

## What Not To Translate

Do not translate:

- JSON keys.
- Placeholder names such as `{count}`, `{name}`, `{date}`.
- Product and protocol names unless a maintainer approves a localized term:
  - SilentSuite
  - Etebase
  - CalDAV
  - CardDAV
  - WebDAV
  - Android
  - GitHub
- URLs, email addresses, file paths, command examples, package names, and code identifiers.
- Cryptographic algorithm names such as XChaCha20-Poly1305, Argon2id, and libsodium.
- Technical labels where localization would make support or security review confusing.

## Tone And Style

SilentSuite's UI should sound clear, calm, and practical.

Use wording that is:

- Direct and easy to understand.
- Careful with privacy and security claims.
- Honest about limitations.
- Consistent with the English source.

Avoid:

- Marketing exaggeration.
- Adding stronger promises than the English source makes.
- Softening security-critical distinctions.
- Turning precise terms like “encrypted” or “plaintext” into vague words like “safe” or “data”.

Examples:

| Prefer | Avoid |
|---|---|
| “Your calendar contents stay encrypted.” | “Your data is completely invisible forever.” |
| “The server stores ciphertext.” | “The server has no data.” |
| “It is not a recovery secret.” | “It cannot affect your account.” |

## Privacy And Security Glossary

Some terms need special care because SilentSuite is privacy/security software.

| English term | Translator guidance |
|---|---|
| zero-knowledge | Use a precise local security/privacy equivalent. If unsure, ask a maintainer. |
| end-to-end encrypted | Must mean encrypted before leaving the device and decrypted only on user devices. |
| plaintext | Preserve the distinction between readable plaintext and encrypted ciphertext. |
| ciphertext | Keep the meaning “encrypted, unreadable content”. |
| server | Do not imply the server can read calendar, contact, or task contents. |
| bridge | Preserve the meaning of the local CalDAV/CardDAV bridge; do not imply a cloud proxy. |
| recovery secret | Do not translate as a normal password or account reset code. |
| account fingerprint | Do not imply a biometric fingerprint, identity document, or recovery secret. |
| self-host | Preserve the meaning “run your own server/deployment”. |

If a sentence describes what SilentSuite, the server, or maintainers can or cannot see, translate conservatively and ask for maintainer review.

## Validation Commands

Run this from the repository root:

```bash
pnpm i18n:check
```

This checks every `apps/web/messages/*.json` file for:

- malformed JSON
- invalid message shapes
- missing keys compared with `apps/web/messages/en.json`
- extra or stale keys
- placeholder mismatches

To print a completeness report without failing on incomplete work-in-progress locale files:

```bash
pnpm i18n:report
```

The report command still exits non-zero for malformed catalogs that cannot be read safely.

Example output:

```text
Web translation message validation

Source locale: en
Reference keys: 26

Locale  Complete  Keys
------  --------  ----
en        100.0%    26/26
de         92.3%    24/26
```

A translation pull request should pass `pnpm i18n:check` before review.

## Pull Request Notes

Please include:

- The language and locale code.
- Whether this is a new locale or an update to an existing locale.
- Who reviewed the translation fluently.
- The output of `pnpm i18n:check`.
- Any privacy/security wording that needs maintainer attention.

Do not paste private calendar, contact, task, account, billing, or log data into issues or pull requests.

## Platform Decision

GitHub pull requests are accepted for the initial English source catalog and small translation updates. Hosted Weblate is the preferred future translation UI if non-technical translator demand grows; self-hosted Weblate remains the fallback if hosted eligibility is not available. Crowdin is not selected for now because its open-source eligibility can be ambiguous for projects with related commercial subscriptions.

The platform decision does not block translation files from living in Git. That keeps contributions reviewable and allows a future translation platform to sync against the same source files.

## Attribution

Prefer normal GitHub pull requests for now so translator commits and reviews stay visible. If Weblate is added later, configure it to preserve translator authorship where possible and route changes through reviewed pull requests.
