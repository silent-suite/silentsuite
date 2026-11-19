# Notes Markdown Profile

What a note body may contain and how every SilentSuite client shows it. The web preview follows this profile now. The Android reading view, which has no Markdown rendering yet, will follow it in its own change and run the same test vectors. This is version 1.

A note body is untrusted input. It can come from another member of a shared notebook or from another app. The profile therefore decides what is shown, and everything it does not list is shown as plain text or not at all.

## How a note is stored

- The item content is the note's Markdown as UTF-8 text. The title and the dates are in the item metadata.
- A client keeps every metadata field it does not know, on every write. Other Etebase notes clients write their own fields.
- The collection type is [`etebase.md.note`](https://docs.etebase.com/type-specs/notes), the same one EteSync Notes uses.

## Syntax

[CommonMark 0.31](https://spec.commonmark.org/0.31.2/) plus three GitHub Flavored Markdown extensions:

- tables
- task list items (`- [ ]` and `- [x]`)
- strikethrough (`~~text~~`, and `~text~`)

Nothing else: no footnotes, no math, no wiki links, no definition lists, no HTML.

## Links

A link is live only when its target starts with `http:`, `https:` or `mailto:`. The comparison ignores case and is made on the target as the Markdown parser hands it over, after it has decoded entities and backslash escapes. Percent escapes are not decoded: `https%3A//example.com` is a relative URL to a browser, so it is not live.

Everything else is shown as the link text, with no link: other schemes (`javascript:`, `data:`, `vbscript:`, `file:`, `intent:`, `content:`, `irc:`, `xmpp:` and the rest), relative paths, `//host/path`, `#fragments`, and empty or missing targets. This holds for inline links, reference links and `<...>` autolinks alike. A live link opens in a new tab or the system handler, never inside the app.

The profile does not rewrite a target: `HTTPS://Example.com/Path` keeps its case. A client may still percent-encode characters that cannot appear in a URL (the web does: a space becomes `%20` and a non-ASCII letter becomes `%XX` escapes), so the vectors use only targets that need no encoding.

Links between notes come after 1.0 and will need their own rule.

## Images

Never loaded and never an image element. Where an image stands, a placeholder shows its alt text. The URL is not shown and is never requested, so a note cannot tell a remote host that it was opened.

## Raw HTML

Shown as literal text, in blocks and inline, including comments. It is never parsed into elements. Markdown inside a raw HTML block stays literal too (`<div>**x**</div>` shows the asterisks).

## Line breaks

CommonMark rules. A single newline is a soft break and is shown as a space. Two trailing spaces or a trailing backslash make a hard break. Many notes apps turn every newline into a break, so this is the choice most likely to surprise someone; it is kept so that both clients and other Etebase clients agree. Not checked: what other Etebase notes clients do with a single newline.

## Frontmatter

Not interpreted in 1.0. A leading `---` block is ordinary Markdown: a thematic break, then text. The export writes frontmatter into files only, never into a note body. Tags in frontmatter may come later and would then hide the block.

## Limits

- **Size:** the profile sets no limit. Each client should keep a 1 MB body from blocking input, and its pull request records the time it takes. The web does not meet that yet: 1 MB of dense Markdown holds the browser's main thread for 2.4 to 6 seconds, which is the parser's cost and not specific to the profile.
- **Nesting:** up to 100 levels must render as Markdown. A line's level is its container markers (`>`, or a bullet or number followed by a space or tab) plus half its leading indentation, with a tab counted as four columns, so `- - - ...` and a list indented deeper on every line count alike. Past 100 on any line, a client may show the body as plain text, or degrade in another way, but it must not crash or stall and the text must stay visible. The parser's time grows with the square of the depth (15 seconds for 10,000 markers on one line, which is 20 KB), and it overflows its stack at a few thousand levels. The web shows the whole body as plain text when a line measures over 100, and also when the parser throws. The measure is a guess made without parsing, so it can be wrong in rare cases: a spaced rule such as `- - - ...` with more than 100 dashes, or a code block line indented more than 200 columns, also shows the body as plain text.
- **Characters:** U+0000 never reaches the output (CommonMark replaces it with U+FFFD). Lone surrogates must not crash a client.

## Decisions made for 1.0

Each can be reopened with the maintainer.

1. **Bare URLs are not links.** `https://example.com` and `www.example.com` written in plain text stay text. GFM's literal autolinks are outside the three extensions above. `<https://example.com>` is a CommonMark autolink and follows the link rule. Bare-URL linking can come later on both clients together.
2. **Line breaks follow CommonMark** (above).
3. **Frontmatter is not interpreted** (above).

## Known limits

- **Deceptive link text:** text such as `https://bank.example` can point somewhere else, and the profile does not compare text with target. Whether a client asks before opening a link is not part of the profile. The web opens it in a new tab at once, and the browser shows the real address only on hover.
- **Bidirectional controls:** the profile does not change text, so a right-to-left override (U+202E) in link text is kept. The vector `link-text-with-right-to-left-override` pins this, so changing it is a profile change.

## Shared test vectors

[`contracts/notes-markdown/v1-vectors.json`](https://github.com/silent-suite/silentsuite/blob/main/contracts/notes-markdown/v1-vectors.json) holds the cases. A client's tests read the file in place, as Android's Birthdays test does with `contracts/birthday-calendar/v1-vectors.json`. The file has `"contract": "silentsuite.notes.markdown"` and `"version": 1`; each reader checks both. The web test exists now; Android's comes with its reading view.

Each case has:

| Field | Meaning |
|---|---|
| `id` | A unique name, lower case with hyphens. |
| `since` | `commonmark` or `gfm`. A client that has not added the GFM extensions yet skips the `gfm` cases by name. |
| `markdown` | The note body, exact. Characters that are hard to see (controls, bidi overrides, lone surrogates) are written as `\u` escapes, so the file holds the exact code units. |
| `expect` | What the client's own result must show (below). |
| `note` | Optional. Why the case exists. |

`expect` is compared with a small extractor each client writes from its own output: the DOM on the web, the block model on Android before any view is built. The vectors name no markup, so neither client's tests depend on the other's.

| Field | Meaning |
|---|---|
| `blocks` | The top-level blocks in order: `heading:1` to `heading:6`, `paragraph`, `list:bullet`, `list:ordered`, `list:task`, `table:RxC` (the header row counts in R), `code`, `quote`, `rule`, and `html` for a raw HTML block shown as literal text. Omitted when a client may degrade. |
| `links` | Every live link, in order, as `{text, href}`. The text is the visible text without image placeholders. A case with `[]` proves that nothing became live. |
| `images` | The alt text of each image placeholder, in order (`""` for none). Its length is the number of images. No image URL may appear anywhere in the output. |
| `text` | Substrings that must appear in the visible text. |
| `textAbsent` | Substrings that must not appear in the visible text. |
| `absent` | Substrings that must not appear in any link target, image URL or attribute the renderer produces. They may still appear as visible text. |
| `inline` | The `em`, `strong`, `code` and `del` spans in document order (an outer span before the span inside it), as `{kind, text}`. |
| `hardBreaks` | The number of hard line breaks. |
| `tasks` | `checked` or `unchecked` for each task item, in document order. |

A client also holds every case to these rules without listing them: no element that can load a resource or run script, no event or style attribute, and every live link opens in a new tab with `rel="noopener noreferrer"`.

## Changing the profile

A change to what is shown is a change to this page and to the vectors in the same pull request, and bumps `version` only when an existing case changes meaning. Adding a case does not.

The Android workflow runs on `android/**`, not on `contracts/**`, so a change to the vectors alone does not start the Android tests. Run them by hand until that is added.
