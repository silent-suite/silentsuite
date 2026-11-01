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

Use browser devtools responsive mode with touch emulation (or a real device) and
check the common widths below, each with a realistic height (for example 320×568,
360×740, 375×667, 390×844, 414×896). The page is mobile-styled below 768px; 768px
and up is desktop.

| Width | Represents |
| ----- | ---------- |
| 320px | small phones (iPhone SE 1st gen) |
| 360px | common Android |
| 375px | iPhone SE 2/3, iPhone 12 mini |
| 390px | iPhone 12/13/14 |
| 414px | large phones (iPhone Plus) |
| 768px | breakpoint — desktop layout takes over |

For each width:

- **Settle first.** Wait until the web fonts have loaded and the page-entry
  transition has finished before judging sizes or positions; measurements taken
  mid-animation are off by a pixel or two.
- **No horizontal scroll** on the page or in `main`. The mobile 3-day / 7-day
  calendar grid scrolls sideways inside its own container by design; that must
  not widen the page.
- **Real taps.** Use touch input, not only mouse clicks. Each control should
  respond to a tap at its centre.
- **Lower fields are reachable.** In every dialog and sheet, scroll to the last
  field and the last button and confirm they can be tapped.
- **Open overlays own the screen.** While a dialog, confirmation or sheet is
  open, it paints above the bottom navigation, and tapping where the bottom nav
  tabs are must not switch pages.
- No clipped controls, and every item in the per-area checklists below is
  reachable with touch.

## Touch targets

- Interactive icon-only controls on mobile should be at least **44×44px**.
- These primary text actions were changed to be at least **44px tall** below
  `md`: the task "New task" and quick-add "Add" buttons, the task dialog's
  Cancel and Create/Save, and the shared confirmation dialog's two buttons. Their
  width follows the label. This is not a rule for every text button, and small
  inline pills (such as the list or calendar choice in a dialog) are not held to
  44×44.
- Use the `touch-target` utility (`app/globals.css`) on mobile icon buttons — it
  applies `min-h-[44px] min-w-[44px]` and centers the icon. It is safe to combine
  with `md:hidden` (the responsive variant still hides the control on desktop).
  Controls shared with the dense desktop sidebar use `max-md:` sizing instead, so
  desktop stays unchanged.
- Desktop-dense controls that intentionally opt out of the mobile minimum use the
  `no-min-size` class.

## Dialogs / bottom sheets

- Create/edit dialogs and their delete confirmations are rendered into the
  document body, so they paint above the bottom navigation and the nav cannot be
  tapped through them: the task dialog, the task delete confirmation, the new
  contact form, the contact delete confirmation, the event dialog and the note
  delete confirmation. Each page renders its own confirmation into the body; the
  shared `ConfirmDialog` component does not do this itself (its only change is
  the 44px mobile height on its two buttons).
- Every dialog must fit a small screen: content that doesn't fit scrolls inside
  the dialog so the lowest fields can be reached. The task dialog's body scrolls
  in a normal container around its form fields. Confirmations stay centred.
- Collection management on mobile uses a slide-up bottom sheet
  (`app/components/MobileCollectionSheet.tsx`) that reuses the same panels the
  desktop sidebar renders, so CRUD logic stays in one place.
- Sheet keyboard and focus ownership:
  - Opening the sheet moves focus to "Close collections", unless focus has
    already moved into the sheet or another dialog is open.
  - Tab and Shift+Tab stay inside the sheet.
  - Escape closes the sheet, but not while typing in a field, while a row menu
    is open, or while a nested confirmation is open.
  - Closing returns focus to the button that opened it.
  - The notebook delete confirmation stays inside the sheet. Escape closes only
    the confirmation, and focus returns to that row's actions button.

## Per-area reachability

### Calendar — reference implementation (#294, #296, #303, #313)

- [x] Primary create reachable on mobile — floating add button
  (`app/(app)/calendar/components/FloatingAddButton.tsx`, `md:hidden`).
- [x] Collection switching reachable on mobile — folder button opens the
  collection sheet (`type="calendar"`).
- [x] Search works on mobile — the inline field above the agenda shows matching
  events from visible calendars only, with a "No results" state. Tapping a result
  opens that event's editor for the whole series; any previously opened
  occurrence is cleared. Typing a query no longer crashes the calendar page (all
  widths).
- [x] Mobile-appropriate views — agenda list, 3 days and 7 days instead of the
  desktop grid (#391, #394, #395).
- [x] Touch targets — mobile toolbar nav/folder buttons use `touch-target`.

### Tasks

- [x] Primary create reachable on mobile — "New task" header button (visible on
  all widths) plus the inline quick-add field, which shrinks to fit narrow
  screens instead of pushing "Add" off the edge.
- [x] Collection switching reachable on mobile — folder button opens the
  collection sheet (`type="tasks"`).
- [x] Search — "Search tasks" matches title, description (notes), location and
  labels within the visible lists, with a no-match message. It stays available
  for read-only accounts and is hidden while tasks load or when there are none.
- [x] Edit on mobile — each row's mobile edit button opens the full task editor
  (title, dates, status, progress, priority, location, URL, labels, notes). The
  editor does not offer moving the task to another list; the task stays in its
  list. On desktop the pencil still expands the row inline. Read-only accounts
  get no editor.
- [x] Delete on mobile — per-row delete button with a confirmation.
- [x] Row layout on narrow screens — below `md` the due date and priority sit on
  a line under the title, so the title keeps room next to the 44px complete,
  edit and delete controls. Desktop rows are unchanged.
- [x] Task dialog on small screens — lower fields scroll into reach, and long
  list names are shortened with an ellipsis instead of widening the dialog.

### Notes

- [x] Reachable on mobile — Notes is a top-level item in the bottom nav
  (between Tasks and Contacts, matching the desktop sidebar order).
- [x] Primary create reachable on mobile — "New note" header button (visible on
  all widths).
- [x] Collection switching reachable on mobile — folder button opens the
  notebooks sheet (`type="notes"`).
- [x] Search reachable on mobile — search field above the note list.
- [x] List ↔ editor navigation on mobile — list hides when a note is open and a
  back control returns to the list.
- [x] Delete — the note delete confirmation appears above the bottom nav.

### Contacts

- [x] Primary create reachable on mobile — "New Contact" header button (visible
  on all widths). After saving, the new contact's detail opens.
- [x] Collection switching reachable on mobile — folder button opens the
  collection sheet (`type="contacts"`).
- [x] Search reachable on mobile — `SearchBar` above the list.
- [x] List ↔ detail navigation on mobile — list hides when a contact is open and
  a back control returns to the list.
- [x] Touch targets — collection trigger, edit, delete, close and the
  remove-phone/email/address buttons are 44×44px on mobile.

### Settings

- [x] Reachable on mobile — Settings is a top-level item in the bottom nav, with
  a grouped overview and a back link on each sub-page (#832). That navigation
  was verified across mobile and desktop widths in #832, and its files are
  unchanged here.
- [ ] Readability of each settings sub-page's content at mobile widths — not
      re-audited as part of #295.

### Collection management

- [x] Calendars, task lists, address books and notebooks are all manageable on
  mobile via the bottom sheet (create / rename / recolor / show-hide / set
  default / delete), using the same panels and actions as the desktop sidebar.
- [x] Sheet controls (show/hide, row actions, menu items, add) are 44px on
  mobile; long names are truncated without widening the sheet; the last row's
  menu can be scrolled into reach.
- These flows were checked in the browser with local sample data for layout,
  touch, focus and keyboard behaviour. That doesn't show that changes are saved
  or synced to an account.

## Known gaps / follow-ups

Open items and known limitations. Some may be split into child issues of #295;
see the epic for any live links.

- Readability audit of settings sub-page content on mobile.
- Moving a task to another list from the task editor is not available (on any
  width).
- New contact: with the required name still empty, the first tap on
  "+ Add phone" can miss because the name error appears and shifts the form
  (all widths, existing behaviour).
- Admin link and the onboarding checklist are only in the desktop sidebar.
- Further mobile calendar view work is tracked in #229.

## Automated coverage

Responsive reachability and behaviour tests live alongside each page and
component:

- `app/(app)/tasks/__tests__/page.test.tsx`
- `app/(app)/contacts/__tests__/page.test.tsx`
- `app/(app)/calendar/__tests__/page.test.tsx`
- `app/(app)/calendar/__tests__/mobile-search.test.tsx`
- `app/(app)/calendar/__tests__/search-real-store.test.tsx`
- `app/(app)/calendar/components/__tests__/EventDialog.test.tsx`
- `app/(app)/notes/__tests__/page.test.tsx`
- `app/components/__tests__/MobileCollectionSheet.test.tsx`
- `app/components/__tests__/MobileCollectionSheet.notebook.integration.test.tsx`
- `app/components/__tests__/CollectionListItem.test.tsx` and the
  `*ListPanel.test.tsx` files
- `app/components/__tests__/confirm-dialog.test.tsx`

Bottom-nav tab access and active state (including the Notes tab) are covered by
`app/components/__tests__/bottom-nav.test.tsx`.

They check that the primary actions, collection switchers and search render on
mobile, and cover search, editor, focus and portal behaviour. jsdom does not
evaluate CSS media queries or paint, so these complement — but do not replace —
the width QA above. Browser checks so far used a local build with sample data;
they cover layout, touch reach and navigation, not syncing, real accounts or real
devices.
