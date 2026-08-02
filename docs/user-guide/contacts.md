# Contacts

Your address book lives at [app.silentsuite.io/contacts](https://app.silentsuite.io/contacts). Names, emails, phone numbers, addresses, notes, photos — every field is encrypted on your device before sync.

## Add a Contact

1. Click **+ Add Contact**.
2. Fill in the fields you want — at minimum a name. Email, phone, address, organisation, birthday, notes, and photo are all optional.
3. Save. The contact is serialized to vCard (`VCARD`), encrypted, and synced.

## Edit / Delete

Open a contact, edit its fields, save. Or open and delete. Changes are re-encrypted and synced.

## Search

The search box at the top of the contacts list filters by name, email, phone, or organisation. Search runs against your locally decrypted data, so it's fast and works offline.

## Favorites

Use the star beside a contact, then choose **Favorites** to show starred contacts from your visible address books. Favorites use the shared vCard contract; Android synchronization requires a SilentSuite Android version that supports contact favorites. A favorite is global contact data, so members of a shared writable address book see and can change the same value.

The favorite flag stays inside the end-to-end encrypted vCard content; it is not placed in collection metadata, indexes, or logs. Offline web changes are stored in the encrypted local item cache and queued without plaintext contact content, then sync after reconnecting. Failed online changes return the star to its previous state. Read-only address books cannot be changed.

## Import

**Settings → Import** accepts `.vcf` files (vCard 3.0 and 4.0). Parsing is local-only — the file content never leaves your browser unencrypted. Multi-contact files are supported (one big `.vcf` with many `BEGIN:VCARD` blocks).

Use **Settings → Import → Manage imported data** to clear an address book's contacts or delete an extra address book and everything inside it.

## Export

**Settings → Export** gives you:

- **Contacts (`.vcf`)** — all contacts as a single vCard file
- **Everything (`.zip`)** — calendars, contacts, and tasks together

Both are built from your locally decrypted data.

## Bridge / CardDAV clients

With the [desktop bridge](./getting-started.md#desktop-caldav--carddav-via-the-bridge) installed, supported desktop CardDAV clients such as Thunderbird, Contacts on macOS, GNOME Contacts, and Evolution can read and write the same contacts through `localhost:37358`.

Multiple address books are supported. Each address book is a separate encrypted collection and appears as its own CardDAV collection in compatible clients.

The Bridge preserves `X-SILENTSUITE-FAVORITE` when a client sends it, but favorite is not a standard CardDAV field. Generic CardDAV clients do not have a promised compatible favorite UI, and clients that rewrite a complete card may strip unknown extensions.

## Sharing

Favorites in a shared address book are shared contact state, not a private per-member preference. Writable members can change them; read-only members cannot.

On Android, starring an aggregate contact may also affect constituent raw contacts owned by other accounts because the native Contacts provider controls aggregation. SilentSuite reads and writes only its own account row.

## Limits in this beta

- No OAuth-based one-click import from Google or iCloud yet — file-based `.vcf` import only. (On the roadmap.)
