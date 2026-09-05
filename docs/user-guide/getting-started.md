# Getting Started

A walkthrough of creating your account and getting your first event syncing across two devices.

## 1. Create an Account

Go to [app.silentsuite.io](https://app.silentsuite.io/signup). For the hosted service the signup flow is four steps:

1. **Account** — email and password.
2. **Verify your email** — signup pauses while SilentSuite emails a verification link to your address. Open that link in the same browser you started signing up in; the plan step stays locked until the link is opened, and your password is not saved while you wait.
3. **Plan** — after verifying, you re-enter your password (the emailed link never contains it), then pick your plan. New hosted billing is annual only: Early Adopter access is €36 annually (€3 per month, billed annually), while future Standard access is €48 annually (€4 per month, billed annually). Choose your trial:
   - **7-day free trial** — full access, no credit card required and no automatic charge.
   - **30-day free trial** — a card secures the trial; Billing shows the exact annual charge date and cancellation deadline, and you can cancel before that deadline. Card and prepaid Bitcoin annual payments include a 30-day refund promise.
4. **Setup** — your encryption keys are derived from your password on this device. Store the password somewhere safe; without it, your data cannot be recovered. SilentSuite has no way to reset it because the server never sees your keys.

Self-hosting your own server? Expand **Advanced Settings** on the signup page and enter your server URL before submitting. The flow becomes Account → Self-Hosting → Admin Setup → Setup, and skips the email-verification gate and the plan / billing steps entirely. Self-hosting is free with every feature unlocked. See the [Self-Hosting guide](../self-hosting/) for the server side of that.

## 2. Add Your First Event

After signup you land on the calendar. Click any cell or tap the **+** button to create an event:

- Title, location, description, all-day, start/end with timezone, reminders (`VALARM`), recurrence rule
- Save — the event is encrypted in your browser before it leaves the page

See [Calendar](./calendar.md), [Contacts](./contacts.md), [Tasks](./tasks.md), and [Notes](./notes.md) for what each section covers.

## 3. Add a Second Device

Your data is only useful if you can read it on the device you're carrying. Three supported surfaces, all talking to the same encrypted account:

### Web (any device with a browser)

Open [app.silentsuite.io](https://app.silentsuite.io/login) on the second device and log in with the same email and password. The web app is an offline-first PWA — you can install it to your home screen or dock from your browser's "install app" menu.

### Android

Install SilentSuite from the channel you want to keep using for updates:

- **Google Play** - use the Play listing if you installed from Play or want Play-managed updates.
- **Obtainium / Zapstore / GitHub Releases** - use these independent channels if you prefer GitHub-managed updates, open app-store distribution, or a direct APK. In **Settings → Mobile**, the QR code opens the [Android installation guide](https://docs.silentsuite.io/user-guide/apps/android), while the separate APK link opens the latest GitHub Release. Official F-Droid inclusion is pending.

Android only allows an app update when the installed app and the update APK are signed with the same certificate. If you installed from Google Play, update through Google Play. If you installed from GitHub Releases or Zapstore, update through that same developer-signed APK channel. When official F-Droid distribution becomes available, keep F-Droid installations on that channel. Switching between Google Play and developer-signed APK channels may require uninstalling and reinstalling the app.

SilentSuite's known Android signing certificate SHA-256 hashes are:

- **Google Play app signing certificate:** `2e10d9ef90276e755bddf086391d7e0c933589c6d36e4e43fae59a7babcb8a49`
- **Developer-signed release certificate for GitHub Releases, Zapstore, and future reproducible F-Droid builds:** `8035a4ff1511e2045c579c905d26e93af6009b239e741ef78542ae04e7a7ca79`

A certificate mismatch warning while switching install channels is expected and does not by itself indicate a compromised build. The Android app supports a custom server URL in advanced settings if you self-host.

### Desktop (CalDAV / CardDAV via the bridge)

If you'd rather use a supported desktop client such as Thunderbird, Calendar on macOS, GNOME Calendar, Evolution, KDE Kontact, or Outlook on Windows, install the **SilentSuite bridge**. It runs a local DAV daemon on `localhost:37358` that translates between your client and the encrypted Etebase backend.

Install commands are in **Settings → Desktop** in the web app.

> The bridge keeps plaintext on `localhost` only — every byte that leaves your machine is encrypted by the bridge first.

### iOS

On the roadmap, coming soon. Native iOS sync is not currently supported, and the EteSync iOS app does not work with silentsuite.io or self-hosted SilentSuite accounts. You can use the SilentSuite web app in an iOS browser, but it does not sync with native iOS Calendar, Contacts, or Reminders.

## 4. Confirm Sync Works

Create an event on device A. Within a few seconds it should appear on device B. If it doesn't:

- Check that both devices are signed in to the **same** account
- Check that both devices report a successful sync in their status indicator
- See the [FAQ](./faq.md) for common issues

That's the success state for setup. From here, see the per-section guides:

- [Calendar](./calendar.md) — events, recurrence, timezones, import/export
- [Contacts](./contacts.md) — vCard CRUD and import/export
- [Tasks](./tasks.md) — priorities, due dates, ICS task export
- [Notes](./notes.md) — encrypted Markdown notebooks
- [How Encryption Works](./encryption-explained.md) — what the server can and can't see
- [FAQ](./faq.md) — anything we get asked twice
