# Screenshot Asset Policy

SilentSuite uses the same approved Android screenshot content across app-store surfaces, with store-specific formatting.

- `source/` contains the original approved device captures used to derive store assets.
- `play-fdroid/` contains opaque rectangular PNGs for Google Play and F-Droid/Fastlane metadata. These are padded to a 544x968 portrait canvas to avoid transparent corners and keep the aspect ratio store-friendly.
- `../../zapstore/screenshots/` contains transparent rounded PNGs for Zapstore.

Do not replace Zapstore screenshots with the older stylized Fastlane mockups. If screenshots change, regenerate both the opaque Play/F-Droid set and the transparent Zapstore set from the same approved source captures.
