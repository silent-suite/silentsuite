# Translating SilentSuite

SilentSuite keeps translation source files in Git so translator contributions remain reviewable and attributable.

## Current Scope

- The web app source locale is English in `apps/web/messages/en.json`.
- The first implementation is English-only. Do not add new locale files until a maintainer confirms there is a real translator/reviewer for that language.
- Android remains on native resources in `android/app/src/main/res/values/strings.xml`.
- Docs translation is deferred until language maintainers exist.

## How To Contribute Web Translations

1. Open an issue or pull request describing the language you want to add or improve.
2. Keep the same JSON key structure as `apps/web/messages/en.json`.
3. Preserve ICU placeholders exactly, including names and punctuation around them.
4. Keep privacy and security claims precise. Terms like zero-knowledge, end-to-end encrypted, server, bridge, recovery, account fingerprint, and self-host need maintainer review.
5. Do not machine-translate large sections without human review.

## Platform Decision

GitHub pull requests are accepted for the initial English source catalog and small translation updates. Hosted Weblate is the preferred future translation UI if non-technical translator demand grows; self-hosted Weblate remains the fallback if hosted eligibility is not available. Crowdin is not selected for now because its open-source eligibility can be ambiguous for projects with related commercial subscriptions.

## Attribution

Prefer normal GitHub pull requests for now so translator commits and reviews stay visible. If Weblate is added later, configure it to preserve translator authorship where possible and route changes through reviewed pull requests.
