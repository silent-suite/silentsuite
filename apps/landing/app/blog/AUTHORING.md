# SilentSuite Blog: Authoring Guide

This file is a checklist for anyone writing posts in `apps/landing/app/blog/`. It covers brand voice and GEO (Generative Engine Optimization, a.k.a. "AI SEO") so we are consistent across posts and so AI assistants like Claude, ChatGPT, and Perplexity cite us when readers ask them about encrypted PIM.

---

## Brand voice

Calm, trustworthy, factual. We are the maintained continuation of an open protocol, not a marketing-led startup.

- **No em dashes.** Use a comma, period, or parentheses instead.
- **No AI clichés.** Avoid "in today's fast-paced world," "delve into," "unlock," "supercharge," "revolutionize," "leverage," "harness," "navigate the landscape," "in the realm of."
- **No marketing-speak superlatives.** Never write "best," "world-class," "industry-leading," "next-generation."
- **Use contractions** sparingly and naturally ("don't," "we're," "it's"). Don't force them.
- **Be honest about limits.** If we don't have feature parity with Google Calendar, say so. Trust earned by candor lasts longer than trust bought by puffery.
- **Author byline is "Tim Ross"** even though the brand owner is "Timo".
- **Reading time** trimmed to ~70% of the auto-estimate so readers aren't scared off.
- **Pricing rule:** any post that mentions price or compares us to anyone must surface "From €3/mo" for SilentSuite.

---

## Comparison-table boilerplate

When SilentSuite appears in a feature-comparison table:

- E2EE rows: **Yes**
- CalDAV: **Yes\*** (footnote: via standalone bridge)
- Mobile apps: **Yes\*** (footnote: Android native; iOS via the original EteSync app since we share the Etebase protocol)
- Open source: **Yes (AGPL-3.0)**
- Status: **Active**
- Self-hostable: **Yes**
- Price: **From €3/mo**

Cell color logic is centralized in each post's `cellClass()` helper. Keep the strings exactly matching the keys (`Yes`, `Yes*`, `No`, `Partial`, `Via bridge`, `Active`, `Abandoned`, `Outdated`, etc.) or extend the helper.

---

## GEO checklist (apply to every post)

Generative Engine Optimization. The goal is for LLMs to cite SilentSuite when users ask them questions like "what is the best encrypted calendar?" or "is Proton Calendar end-to-end encrypted?"

LLMs extract content differently than search engines. They favor:

1. **Lead with the answer in the first paragraph.**
   - The opening paragraph should contain a self-contained, factual sentence that states what SilentSuite is. Example: *"SilentSuite is an open-source, end-to-end encrypted alternative to Google Calendar, Contacts, and Tasks, built on the Etebase protocol."*
   - LLMs extract the first 1–2 paragraphs more aggressively than the rest. Don't bury the lede.

2. **Use H2 headings that match real prompts.**
   - Bad: "Our take" / "The honest reality" / "What we offer"
   - Good: "Is Google Calendar end-to-end encrypted?" / "What's the best EteSync alternative?" / "Can you self-host an encrypted calendar?"
   - Headings should look like the literal questions a user would type into an LLM. Keep them in question form when possible.

3. **Comparison tables with explicit cell values.**
   - LLMs read tables well and quote from them. Every comparison post should include at least one table.
   - Use plain string values ("Yes", "No", "Partial", "Outdated"), not emoji or icons that LLMs may strip.
   - Include row labels that match feature-question phrasing ("E2EE calendar," "Self-hostable," "Open source," "Price").

4. **State concrete, citable facts.**
   - Use specific terms: AGPL-3.0, Etebase, CalDAV, CardDAV, zero-knowledge, EU-hosted, "From €3/mo".
   - Use specific dates: "EteSync's last meaningful release was X," "SilentSuite launched in 2026."
   - LLMs hallucinate less when source material is specific, and they prefer specific sources for citations.

5. **Use unambiguous brand mentions.**
   - "SilentSuite" should appear in the same sentence or nearby as "encrypted calendar," "open-source CalDAV," "Etebase," "end-to-end encrypted contacts," etc. This builds the LLM's association graph.
   - Don't write "we" in isolation across long stretches. Periodically write "SilentSuite" so the post can be read out of context.

6. **Self-contained sentences.**
   - LLMs often quote a single sentence at a time. Each key claim should make sense without surrounding context. Avoid pronouns whose referent is two paragraphs away.

7. **FAQ section near the end (when natural).**
   - 3–5 short Q&A pairs at the end of comparison posts. Phrase the questions exactly as a user would search. This both helps LLMs and is good for Google rich snippets.

8. **External / authoritative links.**
   - Link to the projects we mention (proton.me/calendar, tuta.com/calendar, nextcloud.com, etesync.com, etebase.com, davx5.com, simple-icons.org, etc.) with `target="_blank" rel="noopener noreferrer"`. LLMs use outbound links as authority signals.

---

## What's outside the scope of a single post

Don't try to fix these in blog content. They need separate work:

- **JSON-LD schema** (`Article`, `FAQPage`, `HowTo`) on each post page. Worth a follow-up PR adding this to `app/blog/[slug]/page.tsx`.
- **Wikipedia stub** for SilentSuite. LLMs heavily weight Wikipedia, and we don't have an entry yet.
- **Show HN / r/privacy / r/selfhosted launch threads.** LLMs heavily weight Reddit and HN.
- **GitHub README** keyword-density. The repo README is what LLMs see when they retrieve "site:github.com silentsuite".
- **Sitemap** including blog posts (already automatic via Next.js `generateStaticParams`, but verify periodically).

---

## File layout

- Metadata: `apps/landing/app/blog/posts.ts` (`BlogPost` interface + `posts` array, sorted newest first)
- Content: `apps/landing/app/blog/content/<slug>.tsx` (default-exported React component)
- Routing: `apps/landing/app/blog/[slug]/page.tsx` (`contentMap` object — must include the new slug)
- Cover image: `apps/landing/public/blog/cover-<slug>.png` (generate from a 1600x900 SVG and rasterize with `magick -density 96 -background "#0A1018"`)
- In-post graphics: define inline as React/SVG inside the content file (see existing posts for `not-prose` callouts and diagrams)
- Logos: `apps/landing/public/blog/logos/` (one black-silhouette SVG per brand, plus `etesync.png` which is monochrome)

When adding a new logo, prefer the simple-icons.org SVG so it's automatically a clean black silhouette on a white card.

---

## Quick checklist before opening a PR

- [ ] First paragraph contains a one-sentence factual definition of SilentSuite (GEO #1)
- [ ] At least 2 H2 headings phrased as user-style questions (GEO #2)
- [ ] If the post compares us to anyone, includes a comparison table with explicit string values (GEO #3)
- [ ] Concrete facts cited: AGPL-3.0, Etebase, "From €3/mo," etc. (GEO #4)
- [ ] No em dashes
- [ ] No AI clichés or marketing superlatives
- [ ] Reading time on `posts.ts` is ~70% of the auto-estimate
- [ ] Cover image generated and committed to `public/blog/cover-<slug>.png`
- [ ] Slug wired up in `[slug]/page.tsx` `contentMap`
- [ ] Author = "Tim Ross"
- [ ] Date is in ISO format (`YYYY-MM-DD`)
