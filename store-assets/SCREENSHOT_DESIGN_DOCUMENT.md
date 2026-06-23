# SilentSuite Google Play Screenshot Design Document

**Version:** 1.0
**Date:** 2026-06-23
**Canvas:** 1080 x 1920 px (Google Play phone, 16:9 portrait)
**Status:** Research-backed design recommendation, pending founder approval

---

## 1. Research Findings: How Top Privacy and Productivity Apps Design Store Screenshots

Research was conducted via web search across ASO best-practice guides (AppTweak, ASOMobile, Screenhance, ScreenshotWhale, MobileAction, AppScreenshotStudio) and competitor listings (Proton Calendar, Tuta, DAVx5, EteSync, Bitwarden, Ente, Standard Notes, Anytype, Obsidian, Notion, Todoist, Tasks.org).

### 1.1 The First Three Screenshots Are Everything

ASOMobile's 2025 guide states that approximately 90% of users do not scroll past the third screenshot. The first three images decide whether the app gets installed. Multiple guides (AppScreenshotStudio 2026 Design Guide, AppShot.gallery No-BS Guide, AddJam) confirm that the first screenshot must do the heaviest lifting: one strong headline, one hero visual, leading with the emotional benefit rather than a feature list.

**Implication for SilentSuite:** Positions 1, 2, and 3 must each stand alone as a complete value proposition. A user who only sees three frames should understand: what it does, how it protects them, and why it is different from Google/Apple sync.

### 1.2 Top-Stacked Headlines Outperform Bottom Captions

Strataigize's 2026 ASO guide reports that top-stacked, sub-30-character headlines outperform bottom captions by 15 to 25% in A/B tests. Incipia's study of the top 100 apps found the most common high-performing pattern is a large headline at the top with the app screenshot below it. The MobileSpoon redesign analysis confirms: the message must be short, scannable, and located above the fold.

**Implication for SilentSuite:** The current `bake_captions.py` pipeline places the caption in a footer bar at the bottom of the frame. Research strongly recommends moving the headline to the top of the frame, above the screenshot. This is the single highest-impact change available.

### 1.3 Benefit-Driven Copy Beats Feature Descriptions

AppDrift, AddJam, and the Indie Developer's Guide all emphasize replacing descriptive text ("login screen") with compelling benefits ("start your journey in seconds"). AddJam specifically reports that stripping text from 8-10 words to 3-4 words per screenshot, and leading with the key feature in screenshot 1, improved their conversion. TMS-Outsource found that font sizes below 28pt become illegible in search results, and more than 6-8 words per screenshot reduces conversion rates.

**Implication for SilentSuite:** The founder's 14 headline ideas are a mix of benefits and features. The arrangement below refines each into a benefit-first headline of 3-7 words, with an optional subtext line for context.

### 1.4 Dark Backgrounds for Privacy Apps

AppTweak notes that blue and green hues convey trust and security. The AppScreenMagic 2026 background guide and Screenhance best practices both note that dark backgrounds are increasingly common for privacy, security, and developer-tool apps. Privacy apps like Proton, Tuta, and Bitwarden consistently use dark backgrounds in their store listings. Screenhance specifically warns: the device frame or screenshot must have clear separation from the background. Light on light or dark on dark loses the silhouette at thumbnail size.

**Implication for SilentSuite:** The brand dark navy (#0A1018) is well-suited for the privacy audience. Use a full-bleed navy background with the screenshot inset, creating high contrast. Emerald (#34d399) should be used as an accent color on a single keyword in each headline, not as the headline color itself.

### 1.5 Device Frames: Platform-Matched, Subtle

Screenhance 2026 advises: if you use device frames, match them to the platform (Pixel or Samsung for Google Play). MobileAction's Google Play guide says mockup frames provide visual anchoring. ScreenshotWhale contradicts this, arguing for no frames and raw UI only. However, the weight of evidence from the top 100 apps (Incipia study) is that most successful apps use some form of framing, whether a full device mockup or a subtle rounded-rectangle inset.

**Implication for SilentSuite:** Use a subtle device frame, not a photographic phone mockup. A thin emerald or white rounded border around the screenshot provides anchoring without distraction. This is lighter than a full Pixel mockup but stronger than raw full-bleed captures.

### 1.6 Open Source and Trust Signals

Bitwarden's entire brand positioning leads with "100% Open Source" and source code transparency as a primary security requirement. Proton emphasizes "open source" and "audited" in their listings. The ScreenshotWhale guide notes that social proof and validation placed in the screenshot gallery provides an immediate, powerful nudge for users on the fence.

**Implication for SilentSuite:** "100% Open Source" and "Privacy Focused" are not just feature screenshots. They are trust signals that should appear as recurring footer badges on every frame, and also get one dedicated screenshot each in the back half of the set where they reinforce the decision to install.

### 1.7 Competitor Screenshot Counts

Most productivity and privacy apps use 5-8 screenshots. Proton Calendar uses approximately 5-6. DAVx5 uses 4-5. Bitwarden uses 6-8. The ASOMobile guide recommends using the full available slots (8 for Google Play) because each additional screenshot is a free opportunity to address a different user objection.

**Implication for SilentSuite:** Use all 8 slots. Each slot addresses a distinct objection or use case.

---

## 2. The 8-Screenshot Arrangement

The arrangement follows the proven conversion formula: **Value (1-3) > Proof (4-5) > Differentiation (6-7) > Trust Close (8).**

The first three screenshots answer "What do I get?", "How am I protected?", and "Why is this different from Google sync?". Screenshots 4-5 provide cryptographic proof and sharing capability. Screenshots 6-7 address self-hosting and scale. Screenshot 8 closes on trust with open source and privacy commitment.

### Screenshot 1: The Core Promise

- **Headline:** Your data, encrypted before it leaves your device
- **Subtext:** Zero-knowledge calendar, contacts, and tasks sync
- **App screen shown:** Welcome screen ("End-to-end encrypted sync for your calendar, contacts, and tasks." / "Your data is encrypted before it leaves your device. Only you can read it.")
- **Source headline:** Refined from #1 (Secure your schedule with encryption) + #11 (Zero-Knowledge Calendar, Contacts and Tasks) + #4 (Protected by end to end encryption)
- **Conversion logic:** This is the billboard. A privacy-conscious user scanning Google Play sees the word "encrypted" and "zero-knowledge" immediately, which are the two keywords that differentiate SilentSuite from every default sync app. The welcome screen's own copy reinforces the headline, creating a seamless message.

### Screenshot 2: The Native Apps Integration

- **Headline:** Works with your existing calendar and contacts apps
- **Subtext:** Encrypted collections appear in your native Android apps
- **App screen shown:** Collections overview (list of calendars/contacts/task lists with "Shared collection" and "Read-only collection" indicators)
- **Source headline:** Refined from #7 (Integrates with your native Apps) + #8 (Works seamlessly in the background)
- **Conversion logic:** This addresses the single biggest user question after "is it encrypted?": "do I have to use a new app?" Showing real collection names with shared/read-only badges proves the app is functional and integrated, not a concept. The word "existing" is critical: it tells the user they keep their familiar Android apps.

### Screenshot 3: The Differentiator

- **Headline:** Sync everything, across all your devices
- **Subtext:** Calendar, contacts, and tasks. End to end encrypted.
- **App screen shown:** Collection detail / recent sync activity
- **Source headline:** Refined from #3 (Sync your calendar, contacts and tasks end to end encrypted to different platforms) + #9 (Convenient Workflow across devices) + #10 (Sync on all your devices)
- **Conversion logic:** By position 3, the user who is still looking wants to know scope. This screenshot answers "does it do everything I need?" in one frame. The sync activity screen shows real data flowing, proving the app is live and working, not a mockup. The subtext restates the encryption promise because this is the last frame in the high-visibility zone.

### Screenshot 4: Cryptographic Proof

- **Headline:** Verify your encryption fingerprint
- **Subtext:** Confirm your data is end to end encrypted
- **App screen shown:** Encryption fingerprint verification screen ("Your Encryption Fingerprint")
- **Source headline:** Refined from #12 (Security without compromise) + #4 (Protected by end to end encryption)
- **Conversion logic:** This is the proof point. Privacy communities punish vague claims. Showing an actual fingerprint verification screen demonstrates that the encryption is real, inspectable, and verifiable, not a marketing claim. This screenshot builds credibility with the exact audience most likely to install: people who know what a fingerprint verification is and respect seeing it.

### Screenshot 5: Encrypted Sharing

- **Headline:** Share collections, end to end encrypted
- **Subtext:** Invite members with read or write access
- **App screen shown:** Collection members / sharing screen ("Members", "Invite user", "Read only")
- **Source headline:** Refined from #2 (Manage multiple calendar, contacts and task lists) + new sharing emphasis from v0.3.0-beta
- **Conversion logic:** This is the v0.3.0-beta headline feature. Sharing is the feature that moves SilentSuite from "personal tool" to "usable for families and small teams." Showing the members screen with invite and access controls proves sharing is real and granular, not a roadmap promise.

### Screenshot 6: Self-Hosting Freedom

- **Headline:** Host it on your own server
- **Subtext:** Or use the hosted service. Your choice.
- **App screen shown:** Login / add account screen with "Custom server" toggle visible
- **Source headline:** New, derived from the product's self-host capability (not explicitly in the 14 but implied by the custom server toggle)
- **Conversion logic:** Self-hosting is a major differentiator from Proton Calendar and most commercial privacy apps. The audience that cares about zero-knowledge encryption includes a large segment that also wants to run their own infrastructure. Showing the custom server toggle in the login screen proves this is a first-class feature, not a hidden setting.

### Screenshot 7: Organized and Unlimited

- **Headline:** Unlimited collections, organized your way
- **Subtext:** Labels, categories, and shared lists at a glance
- **App screen shown:** Collections overview (alternative view, or invitations list showing accept/reject)
- **Source headline:** Refined from #6 (Unlimited collections) + #5 (Organize Your Personal Life) + v0.3.0-beta labels/categories feature
- **Conversion logic:** This addresses the power user. "Unlimited" removes a pricing/limit objection. "Organized your way" with labels and categories speaks to users coming from Todoist or Notion who want structure. Showing the collections or invitations screen demonstrates the app handles scale, not just a single calendar.

### Screenshot 8: The Trust Close

- **Headline:** 100% Open Source. Privacy by design.
- **Subtext:** Inspect the code. Self-host if you want. No tracking.
- **App screen shown:** Welcome screen (alternative capture) or the import flow screen
- **Source headline:** Refined from #13 (100% Open Source) + #14 (Privacy Focused) + #12 (Security without compromise)
- **Conversion logic:** This is the closing argument. The privacy audience's final objection is "can I trust you?" The answer is "you don't have to trust us, you can read the code." Leading with "100% Open Source" directly addresses the trust gap. "Privacy by design" is stronger than "Privacy Focused" because it implies architectural commitment, not a marketing stance.

---

## 3. Design Direction

### 3.1 Background: Full-Bleed Dark Navy

Use the brand dark navy (#0A1018) as a full-bleed background on every screenshot. Research shows dark backgrounds are standard for privacy apps (Proton, Tuta, Bitwarden) and convey trust and security. The navy provides high contrast for white headline text and makes the emerald accent pop.

Do not use gradients or patterned backgrounds. A solid navy background creates visual consistency across all 8 frames and lets the screenshot content be the focus.

### 3.2 Device Frame: Subtle Rounded Inset

Do not use a photographic phone mockup (Pixel/Samsung shell). Instead, use a subtle rounded-rectangle inset: the app screenshot is placed with a 12px corner radius and a 2px emerald (#34d399) or white border at 40% opacity. This provides visual anchoring and separation from the navy background without the heaviness of a full device frame.

Research basis: Screenhance warns that the device frame must have clear separation from the background at thumbnail size. A subtle border achieves this more cleanly than a full mockup, and is lighter to produce. The Incipia top-100 study shows most successful apps use some form of framing.

### 3.3 Headline Placement: Top-Stacked, Centered

Move the headline to the top of the frame, above the screenshot. This is the single most important design change from the current pipeline (which uses a footer caption bar).

Research basis: Strataigize's 2026 ASO guide reports top-stacked headlines outperform bottom captions by 15-25% in A/B tests. Incipia's top-100 study confirms the dominant pattern is large text at the top with the screenshot below.

**Layout structure (top to bottom):**
1. Top padding: 80px
2. Headline text: centered, 56-64px font size, bold weight, white (#FFFFFF)
3. Subtext (if present): centered, 32-36px font size, regular weight, white at 70% opacity
4. Gap: 60px
5. Screenshot inset: rounded rectangle with border, scaled to fill remaining space
6. Bottom padding: 60px
7. Footer badges (see 3.6): 40px from bottom

### 3.4 Font Weight and Size

- **Headline:** Bold, 56-64px. Start at 64px and shrink to fit within the safe width (1080 - 160px padding = 920px). Minimum 48px. The `fit_font_size` function in the existing `bake_captions.py` already implements this logic.
- **Subtext:** Regular weight, 32-36px. Optional, used on most but not all screenshots.
- **Footer badges:** 24px, semibold, emerald (#34d399).

Research basis: TMS-Outside found font sizes below 28pt become illegible in search results. AddJam found stripping to 3-4 words improved conversion. The headline must be readable at thumbnail size in Google Play search results.

### 3.5 Headline Text Color: White with Emerald Accent

Headline text is white (#FFFFFF) on the navy background for maximum contrast and legibility. Use emerald (#34d399) to highlight a single keyword in each headline, the word that carries the core benefit.

Examples:
- "Your data, **encrypted** before it leaves your device"
- "Works with your **existing** calendar and contacts apps"
- "Share collections, **end to end encrypted**"
- "**100% Open Source**. Privacy by design."

Research basis: Material Design guidelines note that secondary/accent colors should call attention to headlines and key UI elements. Penn State accessibility guidance recommends emerald green for highlighting words. The accent should be used sparingly (one phrase per headline) to avoid visual noise.

### 3.6 Logo and Wordmark

Place a small SilentSuite wordmark with the arrows-only sync mark in the top-left corner of every frame, at approximately 40px height. This provides brand consistency across all 8 screenshots and ensures the brand is visible even if a single screenshot is shared or embedded elsewhere.

Do not make the logo large. It is a persistent brand cue, not a focal element.

### 3.7 Footer Trust Badges

Add a small footer row with two badges on every screenshot:
- Left: "100% Open Source" in emerald, 24px, with a small code/bracket icon
- Right: "Zero-Knowledge" in emerald, 24px, with a small lock icon

This converts the founder's headline ideas #13 (100% Open Source) and #14 (Privacy Focused) into a recurring trust signal rather than a single screenshot. Research basis: ScreenshotWhale notes that validation placed in the screenshot gallery provides an immediate, powerful nudge. Bitwarden and Proton use similar persistent trust badges.

Screenshot 8 (the trust close) still gets a full headline treatment of "100% Open Source. Privacy by design." because it is worth a dedicated frame as the closing argument, in addition to the footer badges.

### 3.8 Summary of Changes from Current Pipeline

The current `bake_captions.py` and `captions.json` use a footer caption bar (navy bar at the bottom, emerald accent line, centered white text). The recommended changes are:

1. **Move headline from bottom to top.** This is the highest-impact change, backed by A/B test data showing 15-25% conversion improvement.
2. **Add subtext line** below the headline for additional context.
3. **Add emerald keyword highlighting** on one phrase per headline.
4. **Add logo/wordmark** in the top-left corner.
5. **Add footer trust badges** ("100% Open Source" and "Zero-Knowledge") on every frame.
6. **Replace the footer caption bar** with the trust badge row.
7. **Add subtle rounded border** around the screenshot inset instead of full-bleed padding.
8. **Refine all 8 captions** to benefit-driven, 3-7 word headlines (see Section 2).

---

## 4. Prioritization: If Only 4-5 Screenshots Can Be Produced

If production constraints limit the set to 4 or 5 screenshots, produce these in this order:

### Minimum Viable Set (4 screenshots):

1. **Screenshot 1: The Core Promise** ("Your data, encrypted before it leaves your device") on the Welcome screen. This is the billboard. Without it, nothing else matters.
2. **Screenshot 2: Native Apps Integration** ("Works with your existing calendar and contacts apps") on the Collections overview. This answers the most common follow-up question and shows real app functionality.
3. **Screenshot 4: Cryptographic Proof** ("Verify your encryption fingerprint") on the Fingerprint screen. This is the credibility anchor that converts privacy-savvy users.
4. **Screenshot 8: The Trust Close** ("100% Open Source. Privacy by design.") on the Welcome or Import screen. This closes the trust gap for the final install decision.

### Extended Set (5 screenshots, add one):

5. **Screenshot 5: Encrypted Sharing** ("Share collections, end to end encrypted") on the Members screen. This showcases the v0.3.0-beta headline feature and expands the appeal from personal to team/family use.

### Rationale for Omission

Screenshots 3 (sync across devices), 6 (self-hosting), and 7 (unlimited collections) are valuable but address secondary objections. The core conversion path is: What is it? (1) > Does it work with my apps? (2) > Is the encryption real? (4) > Can I trust you? (8) > Can I share? (5). If a sixth screenshot is possible, add Screenshot 6 (self-hosting) next, because it is a strong differentiator from Proton Calendar.

---

## 5. Headline Refinement Notes

The founder's 14 headline ideas, with typos corrected and refined into the final set:

| # | Original (corrected) | Final headline used | Disposition |
|---|---|---|---|
| 1 | Secure your schedule with encryption | Your data, encrypted before it leaves your device | Refined, used in Screenshot 1 (stronger benefit framing) |
| 2 | Manage multiple calendar, contacts and task lists | Share collections, end to end encrypted | Repurposed for Screenshot 5 (sharing focus) |
| 3 | Sync your calendar, contacts and tasks end to end encrypted to different platforms | Sync everything, across all your devices | Refined, used in Screenshot 3 (shorter, punchier) |
| 4 | Protected by end to end encryption | (Merged into Screenshot 1 subtext and Screenshot 4) | Absorbed, not used as standalone |
| 5 | Organize Your Personal Life | Unlimited collections, organized your way | Refined, used in Screenshot 7 |
| 6 | Unlimited collections | (Merged into Screenshot 7 headline) | Absorbed |
| 7 | Integrates with your native Apps | Works with your existing calendar and contacts apps | Refined, used in Screenshot 2 |
| 8 | Works seamlessly in the background | (Merged into Screenshot 2 subtext) | Absorbed |
| 9 | Convenient Workflow across devices | (Merged into Screenshot 3 concept) | Absorbed |
| 10 | Sync on all your devices | (Merged into Screenshot 3 headline) | Absorbed |
| 11 | Zero-Knowledge Calendar, Contacts and Tasks | (Used as Screenshot 1 subtext and footer badge) | Absorbed |
| 12 | Security without compromise | (Merged into Screenshot 8 concept) | Absorbed |
| 13 | 100% Open Source | 100% Open Source. Privacy by design. | Refined, used in Screenshot 8 and footer badge |
| 14 | Privacy Focused | (Refined to "Privacy by design" in Screenshot 8 and footer) | Absorbed |

**New headline added (not from the original 14):**
- "Host it on your own server" (Screenshot 6) derived from the self-hosting capability and the custom server toggle in the login screen. This fills a critical gap in the original set, which did not explicitly address self-hosting despite it being a major differentiator.

---

## 6. Implementation Notes for the Captions Pipeline

The existing `bake_captions.py` script and `captions.json` manifest need the following updates to implement this design:

### 6.1 Layout Changes in `bake_captions.py`

1. Replace the footer caption bar (`draw_caption_bar`) with a top-stacked headline function (`draw_headline_top`) that renders the headline and optional subtext above the screenshot.
2. Add a `highlight` field to the manifest format: `{"capture": "...", "headline": "...", "subtext": "...", "highlight": "encrypted"}`. The script renders the highlighted word in emerald and the rest in white.
3. Add a logo drawing function (`draw_logo`) that places the wordmark in the top-left.
4. Add a footer badge function (`draw_footer_badges`) that renders "100% Open Source" and "Zero-Knowledge" at the bottom.
5. Change the screenshot inset to use a rounded rectangle with a subtle border instead of full-bleed paste.

### 6.2 Updated Manifest Format

```json
{
  "1-encryption-promise.png": {
    "capture": "1-welcome.png",
    "headline": "Your data, encrypted before it leaves your device",
    "subtext": "Zero-knowledge calendar, contacts, and tasks sync",
    "highlight": "encrypted"
  },
  "2-native-apps-sync.png": {
    "capture": "3-collections.png",
    "headline": "Works with your existing calendar and contacts apps",
    "subtext": "Encrypted collections appear in your native Android apps",
    "highlight": "existing"
  },
  "3-sync-all-devices.png": {
    "capture": "7-collection-detail.png",
    "headline": "Sync everything, across all your devices",
    "subtext": "Calendar, contacts, and tasks. End to end encrypted.",
    "highlight": "everything"
  },
  "4-encryption-fingerprint.png": {
    "capture": "4-fingerprint.png",
    "headline": "Verify your encryption fingerprint",
    "subtext": "Confirm your data is end to end encrypted",
    "highlight": "encryption fingerprint"
  },
  "5-encrypted-sharing.png": {
    "capture": "5-sharing-members.png",
    "headline": "Share collections, end to end encrypted",
    "subtext": "Invite members with read or write access",
    "highlight": "end to end encrypted"
  },
  "6-self-host.png": {
    "capture": "2-login.png",
    "headline": "Host it on your own server",
    "subtext": "Or use the hosted service. Your choice.",
    "highlight": "own server"
  },
  "7-unlimited-collections.png": {
    "capture": "3-collections.png",
    "headline": "Unlimited collections, organized your way",
    "subtext": "Labels, categories, and shared lists at a glance",
    "highlight": "Unlimited"
  },
  "8-open-source.png": {
    "capture": "1-welcome.png",
    "headline": "100% Open Source. Privacy by design.",
    "subtext": "Inspect the code. Self-host if you want. No tracking.",
    "highlight": "100% Open Source"
  }
}
```

### 6.3 Capture Mapping

The capture test (`StoreScreenshotsTest.java`) already captures 8 screens. The mapping from test captures to design positions:

| Design position | Test capture | Notes |
|---|---|---|
| 1 | `1-welcome.png` | Welcome / encryption promise |
| 2 | `3-collections.png` | Collections overview with shared/read-only badges |
| 3 | `7-collection-detail.png` | Collection detail / recent sync activity |
| 4 | `4-fingerprint.png` | Encryption fingerprint verification |
| 5 | `5-sharing-members.png` | Collection members / sharing screen |
| 6 | `2-login.png` | Login / add account with custom server toggle |
| 7 | `3-collections.png` (alt) or `6-invitations.png` | Collections overview or invitations list |
| 8 | `1-welcome.png` (alt) or `8-import.png` | Welcome screen or import flow |

Note: Positions 2 and 7 both use the collections overview capture. If a distinct second capture of collections (e.g., scrolled to a different position, or showing labels/categories from v0.3.0-beta) is available, use it for position 7 to avoid visual repetition. Alternatively, use the invitations list (`6-invitations.png`) for position 7 to show the accept/reject sharing flow.

---

## 7. Final Summary

This design document recommends 8 screenshots arranged in a Value > Proof > Differentiation > Trust Close sequence. The three highest-impact recommendations, backed by research, are:

1. **Move headlines to the top of the frame** (above the screenshot), not the bottom. A/B test data shows 15-25% conversion improvement for top-stacked headlines.
2. **Lead with the encryption promise in screenshot 1**, using the welcome screen, and make the first three screenshots each a complete standalone value proposition.
3. **Add recurring footer trust badges** ("100% Open Source" and "Zero-Knowledge") on every frame, with a dedicated trust-close screenshot at position 8.

The design uses the brand dark navy background, white headlines with emerald keyword accents, a subtle rounded border around screenshots, and a small logo wordmark in the top-left corner of every frame.
