# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary — non-engineer curators** (ops, support, sales, marketing) who
maintain the shared truth their agents read. They already wrote these docs
scattered across repos, gists, Notion, and laptops; every agent carries its
own drifting copy and no one can see the full set. Their context is a
browser, not a terminal — no Git, no markdown toolchain. The job: author,
version, and curate markdown documents; group them into ordered corpora;
hand agents a single live, approved source over MCP. They review agent
proposals, never let an agent auto-write.

**Secondary — engineers** running the Git-free CLI (`pnpm corpus`) from a
terminal or CI against the same optimistic-concurrency contract as the web
editor. Same data, different surface.

**Tertiary — the agents themselves**, read-only over MCP, credential-scoped
to one project's bound corpus. They read the current approved version and
propose edits a human accepts per hunk. They never see review state.

## Product Purpose

Corpus is a Git-free canonical markdown context store for teams — the
canonical place a team keeps the documents its AI agents reason over. It is
**not a prompt manager, not a vector database, and not a RAG pipeline**: it is
the documents a team already has, made shared, versioned, and served as one
source of truth instead of stale prompt files copied into every agent.

Success: one approved version of every document, maintained by non-engineers,
read live by agents over MCP with per-project OAuth/API-key isolation. One
edit updates every corpus and every agent that reads it at once. Never a lost
write — optimistic-concurrency conflict detection turns a racing save into a
409, and a verifiable append-only version ledger lets any version be restored.
Agents propose; only humans approve. The whole project is exportable as a
deterministic, content-addressed bundle that re-imports to the same hash.

## Positioning

Documents are shared across corpora by reference, not copied. A curator edits
one source document; every corpus and agent that reads it receives the
approved change. Corpus makes this linkage visible while keeping authorship
and agent consumption on separate sides of a human approval boundary.

## Operating Context

Curators enter a project to work on documents. The populated project opens
Documents, where recently modified documents — including newly created ones —
are visible before the folder browser. Search and folders support finding the
rest; Activity remains available when a curator needs the event history.

People write and review in the web app. Engineers can use the Git-free CLI,
and agents consume an ordered corpus over MCP with a credential bound to one
project and corpus. Documents may appear in several corpora without copies.

## Capabilities and Constraints

- Tenancy is Organization → Project. A project owns its documents, folders,
  corpora, and credentials.
- Document writes are versioned and use optimistic concurrency. A conflict
  requires an explicit resolution rather than a silent overwrite.
- Agents read approved content and may propose edits or new documents. Human
  review state stays outside MCP and the portable bundle.
- Project owners administer Connections and export or import bundles.
- The project bundle is deterministic and content-addressed.

## Brand Commitments

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

## Evidence on Hand

The reported use pattern is that people leave the Activity home and click
Documents to work. Users also report difficulty finding a document soon after
creating it. No usage counts or study results accompany this feedback.

`README.md`, `DESIGN.md`, and the current web and CLI implementations document
the existing workflows and product boundaries. The product record contains no
customer testimonials or performance claims.

## Product Principles

1. **The system recedes so the graph speaks.** The distinctive product truth
   is one document feeding many agents. Make that relationship legible.
2. **Show the truth, not the tool.** Start from the documents people maintain
   and make recent work easy to find. Keep Git and markdown tooling out of the
   curator's path.
3. **Never lose a write.** Detect concurrent edits, preserve verifiable
   history, and require explicit conflict resolution.
4. **Approve, then serve.** Agents can propose changes; people approve what
   becomes shared context. Review state does not leak into agent reads.
5. **One source, many readers.** A document is shared by reference across
   corpora, so one approved edit reaches every reader.

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
