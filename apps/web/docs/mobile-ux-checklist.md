# Mobile web UX checklist

Tracking checklist for the mobile web experience of the SilentSuite web app
(`app.silentsuite.io`). It backs epic [#295](https://github.com/silent-suite/silentsuite/issues/295)
and is the reference used for browser QA and for scoping the mobile UX child
issues.

The web app is mobile-first below the Tailwind `md` breakpoint (768px). On mobile
the desktop sidebar (`app/components/sidebar.tsx`, `hidden md:flex`) is hidden, so
every piece of functionality that lives in the sidebar on desktop **must have a
mobile-reachable replacement**. The bottom navigation
(`app/components/bottom-nav.tsx`, `md:hidden`) provides top-level page switching;
per-page primary actions, collection switching, and search are the
responsibility of each page.

## How to QA

Use browser devtools responsive mode (or a real device) and check the common
widths below. The page is mobile-styled below 768px; 768px and up is desktop.

| Width | Represents |
| ----- | ---------- |
| 320px | small phones (iPhone SE 1st gen) |
| 360px | common Android |
| 375px | iPhone SE 2/3, iPhone 12 mini |
| 390px | iPhone 12/13/14 |
| 414px | large phones (iPhone Plus) |
| 768px | breakpoint — desktop layout takes over |

For each width, confirm there is no horizontal scroll, no clipped controls, and
that every item in the per-area checklists below is reachable with touch.

## Touch targets

- Interactive icon-only controls on mobile should be at least **44×44px**.
- Use the `touch-target` utility (`app/globals.css`) on mobile icon buttons — it
  applies `min-h-[44px] min-w-[44px]` and centers the icon. It is safe to combine
  with `md:hidden` (the responsive variant still hides the control on desktop).
- Desktop-dense controls that intentionally opt out of the mobile minimum use the
  `no-min-size` class.

## Dialogs / bottom sheets

- Collection management on mobile uses a slide-up bottom sheet
  (`app/components/MobileCollectionSheet.tsx`) that reuses the same panels the
  desktop sidebar renders, so CRUD logic stays in one place.
- Create/edit dialogs (events, tasks, contacts) are centered modals with a focus
  trap; they must be fully usable and dismissable on small screens.

## Per-area reachability

### Calendar — reference implementation (#294, #296, #303, #313)

- [x] Primary create reachable on mobile — floating add button
  (`app/(app)/calendar/components/FloatingAddButton.tsx`, `md:hidden`).
- [x] Collection switching reachable on mobile — folder button opens the
  collection sheet (`type="calendar"`).
- [x] Search reachable on mobile — inline search field above the agenda view.
- [x] Mobile-appropriate view — agenda list instead of the desktop grid.
- [x] Touch targets — mobile toolbar nav/folder buttons use `touch-target`.

### Tasks

- [x] Primary create reachable on mobile — "New task" header button (visible on
  all widths) plus the inline quick-add field.
- [x] Collection switching reachable on mobile — folder button opens the
  collection sheet (`type="tasks"`).
- [x] Create / edit / delete flows reachable on mobile — task dialog and per-row
  edit/delete buttons sized to 44px on mobile.
- [x] Touch targets — collection trigger uses `touch-target`.
- [ ] Search / filter on mobile — **not implemented** (no task search yet).
      Tracked as a child issue.

### Contacts

- [x] Primary create reachable on mobile — "New Contact" header button (visible
  on all widths).
- [x] Collection switching reachable on mobile — folder button opens the
  collection sheet (`type="contacts"`).
- [x] Search reachable on mobile — `SearchBar` above the list.
- [x] List ↔ detail navigation on mobile — list hides when a contact is open and
  a back control returns to the list.
- [x] Touch targets — collection trigger uses `touch-target`.

### Settings

- [x] Reachable on mobile — Settings is a top-level item in the bottom nav and
  each settings sub-page is full-width on mobile.
- [ ] Sub-page navigation audit on mobile (account, security, sharing, import,
      export, subscription, desktop, mobile) — confirm every sub-page is
      reachable and readable at mobile widths. Tracked as a child issue.

### Collection management

- [x] Calendars, task lists and address books are all manageable on mobile via
  the bottom sheet (create / rename / recolor / show-hide / set default /
  delete), reusing the desktop panels.
- [ ] Verification pass that every collection action available on desktop is also
      available and usable from the mobile sheet. Tracked as a child issue.

## Known gaps / follow-ups

These are tracked as child issues of #295 (see the epic for live links):

- Mobile tasks search/filter.
- Mobile settings sub-page reachability audit.
- Mobile collection-management parity verification.
- Audit for any remaining hidden desktop-only functionality with no mobile path.
- Mobile calendar view options (3-day / week) — coordinated with #229.

## Automated coverage

Responsive reachability smoke tests live alongside each page:

- `app/(app)/tasks/__tests__/page.test.tsx`
- `app/(app)/contacts/__tests__/page.test.tsx`
- `app/(app)/calendar/__tests__/page.test.tsx`

They assert that the primary create action, the collection switcher, and (where
applicable) search render on mobile. jsdom does not evaluate CSS media queries,
so these complement — but do not replace — the manual width QA above.
