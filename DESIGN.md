# Design System — Corpus

## Product Context

- **What this is:** Corpus — a Git-free canonical context store for teams. Non-engineers
  write markdown documents, group them into ordered agent collections, and agents
  consume those collections over MCP.
- **Who it's for:** Non-engineers on a team (ops, support, sales, marketing)
  who maintain the shared truth their agents read.
- **Space/industry:** AI agent tooling / internal knowledge infrastructure.
- **Project type:** Web app (data-dense project UI, TanStack Start on
  Cloudflare Workers).

**The memorable thing this system serves:** _you can see that one document
feeds many agents — no copies._ Every decision below recedes so the single
blue linkage fan-out on the project graph is the loudest thing on screen.
A system that is expressive everywhere would bury the one moment the product
exists to deliver.

## Aesthetic Direction

- **Direction:** Industrial / Utilitarian — calm, data-dense, function-first.
- **Decoration level:** Minimal — typography and one accent do all the work.
  No gradients, no texture, no decorative shapes. The project graph is the
  only figure on the page; everything else is ground.
- **Mood:** A precise instrument, not a dashboard. Quiet, engineered,
  trustworthy. Closer to Linear than to a SaaS marketing site.
- **Reference:** approved mockup Variant A (not checked into the repo).

## Typography

- **Display / Hero:** Geist — weight 600. (Decided in design consultation,
  overriding the earlier Inter pick: Geist is purpose-built for product UI,
  has stronger tabular figures for data-dense node cards/version chips, and
  is not the converged-on AI-default that Inter is.)
- **Body:** Geist — weight 400.
- **UI / Labels:** Geist — weight 500 (column headers, badges).
- **Data / Tables / chips:** Geist with `font-variant-numeric: tabular-nums`
  (version chips, counts, timestamps must not jitter column width).
- **Code / MCP URL:** Geist Mono.
- **Loading:** self-hosted variable woff2, latin subset, served as a static
  asset (no Google Fonts CDN — consistent with the no-external-dependency
  posture of the Workers bundle). NOT a system stack.
- **Scale (rem, 16px browser-default root** — no root override; sizing
  lives in component Tailwind `text-*` utilities + the `.md`
  design-system block. Every role was shifted **up one standard step**
  for app-wide readability; the rem ladder itself is the stock Tailwind
  scale, unchanged**):**
  - xs 0.75 (reserve — smallest, currently unassigned)
  - sm 0.875 (chips, column headers, node metadata, sr microcopy)
  - base 1.0 (secondary text)
  - lg 1.125 (body, node titles, rendered-document body)
  - xl 1.25 (section headings)
  - 2xl 1.5 (page title "Home")
  - Line-height: 1.5 body, 1.25 headings.

## Color

- **Approach:** Restrained. A slate neutral ramp plus exactly ONE accent.
  Color is spent almost entirely on the shared-linkage moment so it reads as
  meaningful, never decorative.
- **Neutrals (slate):**
  - page bg `#f8fafc` (slate-50)
  - surface `#ffffff`
  - hairline border `#e2e8f0` (slate-200)
  - ghost stroke `#cbd5e1` (slate-300)
  - secondary text `#64748b` (slate-500)
  - primary text `#0f172a` (slate-900)
- **Accent (blue), reserved for two uses only — primary action + shared-linkage emphasis:**
  - accent `#2563eb` (blue-600)
  - accent hover `#1d4ed8` (blue-700)
  - accent wash `#eff6ff` (blue-50) — the "In N collections" badge background
- **Two-blue family (intentional, not drift):** the marketing site
  (corpus-site) uses `#3b82f6` (blue-500) as the primary surface
  accent with `#2563eb` (blue-600) as the hover / primary-dark — a
  slightly lighter shade for breathability against the airy white
  expanses of a landing page. The app uses `#2563eb` (blue-600) as
  THE single accent because chip / button density against
  `#e2e8f0` (slate-200) hairlines needs the darker stop for
  contrast. Documented here so a third blue does not arrive later.
- **Semantic (used sparingly, inline only):**
  - success `#15803d` warning `#b45309` error `#b91c1c` info `#2563eb`
  - toast surface `#334155` (slate-700) on white text
- **Dark mode:** Not in v0. Strategy when added: redesign surfaces (do not
  invert), reduce accent saturation ~15%, keep the single-accent discipline.

## Spacing

- **Base unit:** 8px (4px allowed for intra-component only).
- **Density:** Comfortable — node cards breathe; columns are dense but never
  cramped. Touch targets >= 44px.
- **Scale (px):** 2xs 2 · xs 4 · sm 8 · md 16 · lg 24 · xl 32 · 2xl 48 · 3xl 64

## Layout

- **Approach:** Grid-disciplined. The existing left sidebar shell (~240px) +
  the deterministic layered project graph. No editorial asymmetry.
- **Grid:** sidebar + fluid main; the graph is 3 fixed columns
  (Documents · Collections · MCP) computed as a pure function of data.
- **Max content width:** index/list pages fill the available main width
  (the house style — a primary action stays anchored to a full-width
  content panel, never flung to the far screen edge). Long-form prose
  (rendered markdown document bodies, version history) keeps a readable
  measure (~max-w-5xl, ≈1024px) — a reading constraint, not a stylistic
  cap. The project graph always fills available main width.
- **Border radius:** sm 4px (chips/badges) · md 6px (node cards, buttons,
  inputs) · lg 8px (panels) · full 9999px (the "In N collections" pill only).
- **Responsive:** < 720px the home defaults to the List tab; the graph, when
  opened, stacks vertically with connectors as left-rail brackets.

## Motion

- **Approach:** Minimal-functional. Motion exists only to aid comprehension;
  the graph itself never animates layout (determinism > delight here).
- **Allowed motions (the only ones):**
  - hover/focus linkage reveal: non-path nodes → opacity 0.4, 150ms ease-out
  - post-seed toast: fade in 150ms, auto-dismiss ~5s, fade out 150ms
- **Easing:** enter ease-out · exit ease-in · move ease-in-out
- **Duration:** micro 100ms · short 150ms · medium 250ms (cap; nothing longer)
- **Forbidden:** node entrance choreography, layout reflow animation,
  scroll-driven effects, skeleton pulse (loading skeleton is static/calm).

## Implementation notes (Tailwind v4)

`src/styles.css` is `@import "tailwindcss";` — Tailwind v4, CSS-first. Express
these tokens in an `@theme { … }` block in `styles.css` (CSS variables), NOT a
`tailwind.config.js`. Self-host Geist as a static asset and declare it via
`@font-face` + `--font-sans` / `--font-mono` in the same file.

## Decisions Log

| Date       | Decision                      | Rationale                                                                                                                                                  |
| ---------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-17 | Initial design system created | /design-consultation; formalizes the existing slate/blue Tailwind system + design-review token block                                                       |
| 2026-05-17 | Typeface = Geist (not Inter)  | Purpose-built product UI face, strong tabular-nums for data-dense nodes, avoids the converged-on AI-default signal. Overrides design-doc D4.               |
| 2026-05-17 | Single-accent discipline      | Color budget spent on the shared-linkage fan-out so the product's one memorable moment is unmissable                                                       |
| 2026-05-17 | No motion on graph layout     | Determinism and legibility at 40 nodes beat demo-gif delight                                                                                               |
| 2026-05-17 | Type roles +1 standard step   | App-wide readability bump done in component `text-*` utilities + the `.md` block (no root/CSS override): body sm→base→lg, etc. Stock Tailwind scale, no px |
