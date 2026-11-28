# How to Manage Your Contacts

Your contacts are end-to-end encrypted. Only your devices can read them.

In the web app your address book is at [app.silentsuite.io/contacts](https://app.silentsuite.io/contacts). Names, emails, phone numbers, addresses, notes and photos are all encrypted on your device before sync.

Contacts can be organized into multiple address books. Each address book is a separate encrypted collection that syncs across your devices and compatible CardDAV clients.

## Add a Contact

1. Open the Contacts view.
2. Tap or click "Add Contact."
3. Enter the contact details (name, email, phone, address, notes).
4. Save. The contact is encrypted on your device and synced.

## Edit a Contact

1. Open the contact you want to change.
2. Make your changes.
3. Save. The updated contact is re-encrypted and synced to your other devices.

## Search

The search box at the top of the contact list filters by name, email, phone number or organization. Search runs on the contacts already decrypted on your device, so it works offline.

## Favorites

Select the star beside a contact and use the **Favorites** view to filter starred contacts from visible address books. Favorites use the shared vCard contract; Android synchronization requires a SilentSuite Android version that supports contact favorites. In a shared address book the value is global to all members; writable members can change it and read-only members cannot.

Favorite status remains inside the end-to-end encrypted vCard content, not plaintext collection metadata, indexes, or logs. Offline web changes use encrypted local item content plus a content-free queue record. An online failure rolls the star back. Read-only address books cannot be changed.

On Android, starring an aggregate contact may also affect constituent raw contacts owned by other accounts, because the native Contacts provider controls aggregation. SilentSuite reads and writes only its own account row.

## Delete a Contact

1. Open the contact.
2. Select delete.
3. The deletion syncs across all your devices.

## Import

**Settings → Import** accepts vCard (`.vcf`) files, including one file holding many contacts. This makes it straightforward to migrate from other services or consolidate contacts from multiple sources. The file is parsed in your browser, so its contents never reach the server unencrypted.

If you imported into the wrong place, use **Settings → Import → Manage imported data** to clear an address book's contacts or delete an extra address book and everything inside it.

## Export

Export your contacts at any time. Your data belongs to you, and you can take it with you. **Settings → Export** offers:

- **Contacts (`.vcf`)**: all contacts as a single vCard file
- **Everything (`.zip`)**: calendars, contacts and tasks together, plus your notebooks as Markdown files when you have any ([Notes](./notes.md#export))

Both are built from the data already decrypted on your device. When your account has notebooks, **Everything** also lists your notes from the server again, so it then needs a connection.

## Desktop CardDAV Clients

With the [SilentSuite Bridge](./apps/dav-bridge.md) installed, supported desktop CardDAV clients such as Thunderbird, Contacts on macOS, GNOME Contacts and Evolution can read and write the same contacts through `localhost:37358`. Each address book appears as its own CardDAV collection.

SilentSuite uses the private `X-SILENTSUITE-FAVORITE` vCard extension. The Bridge preserves received extensions, but favorite is not standardized across CardDAV. Generic CardDAV clients have no promised compatible favorite UI, and complete-card writers may remove unknown extensions.
