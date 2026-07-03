# Product

## Register

product

## Users

**Primary — non-engineer curators** (ops, support, sales, marketing) who
maintain the shared truth their agents read. They already wrote these docs
scattered across repos, gists, Notion, and laptops; every agent carries its
own drifting copy and no one can see the full set. Their context is a
browser, not a terminal — no Git, no markdown toolchain. The job: author,
version, and curate markdown documents; group them into ordered collections;
hand agents a single live, approved source over MCP. They review agent
proposals, never let an agent auto-write.

**Secondary — engineers** running the Git-free CLI (`pnpm corpus`) from a
terminal or CI against the same optimistic-concurrency contract as the web
editor. Same data, different surface.

**Tertiary — the agents themselves**, read-only over MCP, credential-scoped
to one project's bound collection. They read the current approved version and
propose edits a human accepts per hunk. They never see review state.

## Product Purpose

Corpus is a Git-free canonical markdown context store for teams — the
canonical place a team keeps the documents its AI agents reason over. It is
**not a prompt manager, not a vector database, and not a RAG pipeline**: it is
the documents a team already has, made shared, versioned, and served as one
source of truth instead of stale prompt files copied into every agent.

Success: one approved version of every document, maintained by non-engineers,
read live by agents over MCP with per-project OAuth/API-key isolation. One
edit updates every collection and every agent that reads it at once (documents
are graph nodes shared by reference, not copied). Never a lost write —
optimistic-concurrency conflict detection turns a racing save into a 409, and a
verifiable append-only version ledger lets any version be restored. Agents
propose; only humans approve. The whole project is exportable as a
deterministic, content-addressed bundle that re-imports to the same hash.

## Brand Personality

**Quiet, engineered, trustworthy.** A precise instrument, not a dashboard.
Function-first; the system recedes so the product's one memorable moment —
one document feeding many agents, no copies — is the loudest thing on screen.
Voice is confident, plain, and expert: it states what is true without
announcing itself. No marketing flourish, no performative delight. Closer to
Linear than to a SaaS marketing site, but its own instrument — not a Linear
clone.

## Anti-references

- **SaaS marketing dashboards.** Gradient heroes, the hero-metric template
  (big number, small label, supporting stats), bouncy identical card grids,
  the "modern AI product" template. Corpus is a tool you work in, not a page
  that sells.
- **Notion-style decorative chrome.** Emoji icons, rounded card stacks, warm
  paper tints, decorative illustration. A functional surface for shared
  truth, not a doc-toy.
- **The AI-default cream / warm-neutral body.** The 2026 saturated
  warm-neutral band (sand / cream / parchment / paper). Corpus is slate +
  white, deliberately cool — warmth is not carried by the background.
- **A generic "modern" Linear-clone.** Copying Linear's surface without its
  discipline: dark-by-default, blurred glassmorphism, kinetic motion. Corpus
  is light, still, and its own thing.

## Design Principles

1. **The system recedes so the graph speaks.** Restraint everywhere except
   the one moment the product exists to deliver — one document feeding many
   agents. A system that is expressive everywhere would bury that fan-out.
   Color, motion, and decoration are spent on that moment, not spread thin.
2. **Show the truth, not the tool.** Non-engineers author docs they already
   have; the tool's job is to make them shared and versioned, not to feel like
   a thing to learn. No Git, no markdown toolchain, no chrome that announces
   itself. The interface gets out of the way of the content.
3. **Never lose a write.** Trust is the whole product. Optimistic-concurrency
   conflict detection, a verifiable append-only version ledger,
   agents-propose / humans-approve, and a deterministic content-addressed
   bundle are the contract. Every surface that touches authorship must make
   correctness legible — a conflict is a side-by-side merge, never a silent
   overwrite.
4. **Approve, then serve.** Agents read approved docs; review state
   (comments, suggestion threads) is off-MCP and out of the bundle. The
   boundary between human authorship and agent consumption is the
   architecture, not a setting — design it into every flow, not behind a
   toggle.
5. **One source, many readers.** Documents are shared by reference, not
   copied — one edit propagates to every collection and every agent at once.
   The UI makes that linkage visible and the sharing unambiguous: the "In N
   collections" fan-out is the product's signature, not a footnote.

## Accessibility & Inclusion

**Target: WCAG 2.1 AA.** Body text ≥4.5:1 contrast against its background;
large text and UI components ≥3:1; full keyboard navigation across the
editor, graph, and review surfaces.

- **Reduced motion is honored.** Motion is minimal-functional by default
  (DESIGN.md caps duration at 250ms and forbids layout reflow animation);
  `prefers-reduced-motion: reduce` gets instant or crossfade alternatives.
  The project graph never animates layout — determinism over delight.
- **Color-blind safe semantics.** Review states (comment amber, suggestion
  green / rose) must not rely on hue alone — pair every wash with a text or
  icon cue so the state reads in monochrome and to deuteranope/protanope
  users. Semantic colors are scoped exceptions; the single blue accent stays
  the only action color.
- **Data legibility.** Tabular-nums on all counts, version chips, and
  timestamps so columns don't jitter. Touch targets ≥44px. The document
  reading surface (`.md`) uses a 1.7 body line-height and a readable measure
  for non-engineer authors reading as much as they edit.
