// Sample project content — segregated from core code on purpose.
// This is demo data only: the canonical "Load sample data" project a
// brand-new user gets on first load, with a fake consumer product
// (Marlow) and fake marketing/policy markdown bodies. Nothing here is
// production logic; the only reasons it lives in src/ at all are
// (1) ProjectStore.seedExample writes it in one tx, and (2) the
// project-graph empty state composes the same shape into the ghost
// preview. Single source of truth so the preview and the actual seed
// cannot silently disagree.
//
// Pure data, zero IO. Slugs and titles stay plain `string` (internal
// data, not a trust boundary); seedExample lifts them to branded ids
// via asDocumentSlug / asCollectionSlug at write time.

export type ExampleDoc = Readonly<{
  slug: string;
  title: string;
  markdown: string;
}>;

export type ExampleCollection = Readonly<{
  slug: string;
  name: string;
}>;

export type ExampleAttachment = Readonly<{
  collectionSlug: string;
  documentSlug: string;
  position: number;
}>;

export type ExampleAgent = Readonly<{ slug: string; name: string }>;

export type ExampleAgentLink = Readonly<{
  collectionSlug: string;
  agentSlug: string;
}>;

const PRODUCT_MD = `# Marlow

A monthly comfort subscription. Each kit pairs one paperback novel
with a small ritual object — a hand-thrown mug, a beeswax candle, a
tin of loose-leaf tea — and a printed letter from the curator. Kits
follow emotional seasons: rest, return, repair, root. $34/month,
ships the first Tuesday.

## Who it's for

Women, 28–45. Urban or close-in suburbs. Professional, often in a
caregiving or service role (teaching, healthcare, nonprofit,
management). Already buys novels, journals, and candles individually;
wants someone else to do the choosing. Reads 6–12 books a year and
wishes it were more. Has tried Audible and didn't stick with it.
Disposable income, but not luxury — picks Trader Joe's over Whole
Foods.

## What makes it different

- **One novel, chosen.** No "five books to pick from." The curator
  picks, with a letter explaining why.
- **A small object, not swag.** Hand-thrown, hand-poured, hand-tinned.
  Real artisans, named in the letter.
- **A theme, not a haul.** Kits follow seasons of life. October's
  "Rest" kit is a fall novel + a wool throw + a sleep tea. December's
  "Return" kit is a homecoming novel + a candle + a hot cocoa tin.
- **Pause anytime.** Subscribers can skip a month with one tap; we
  won't email about it.

## Pricing

- **$34/month**, ships free in the US.
- **$31/month** on a 6-month prepay.
- **First-kit guarantee:** if the first kit doesn't land, full refund
  — keep the kit.

## What sales should know

- The objection we hear most: "I already have too many candles." Lead
  with the novel + letter, not the object.
- We do **not** do gift cards or one-off purchases. The subscription
  IS the product. Don't promise otherwise.
- Corporate gifting requests go to gifting@marlow.example — we don't run
  bulk through sales.
`;

const BRAND_VOICE_MD = `# Brand Voice

Warm, direct, never condescending.

## Principles

- **Specific over abstract.** "The hand-thrown mug from October's
  kit," not "items in your subscription."
- **Confident, never apologetic.** We picked the book on purpose. We
  don't say "we hope you like it." We say "here's why."
- **Second person, short sentences.** Write like you're handing the
  kit across a kitchen table.
- **Treat subscribers as adults.** No exclamation points. No "treat
  yourself." No "you deserve this."

## Vocabulary

- **Use:** kit (not box), curator (not editor), pause (not cancel),
  letter (not insert).
- **Avoid:** "self-care," "treat yourself," "indulge," "luxury,"
  "exclusive."

## Examples

**Don't:**

> We're so excited to share October's box with you! Treat yourself to
> a cozy night in.

**Do:**

> October's kit ships next Tuesday. The novel is short — you'll
> finish it in a weekend. The mug is heavy on purpose.

**Don't:**

> Sorry to see you go! We hope you'll come back soon.

**Do:**

> Paused. Your next kit will ship when you turn it back on. The
> October letter is in your account if you want to read it now.
`;

const REFUND_POLICY_MD = `# Refund Policy

Customers may request a refund within 30 days of a kit's ship date.
Full amount, no questions, keep the kit.

## How to request

Email hello@marlow.example with the order number. Refunds process in 3–5
business days to the original payment method.

## What's covered

- The first kit, always (first-kit guarantee).
- Any kit that arrived damaged or incomplete — send a photo, we ship
  a replacement.
- Any kit within 30 days of its ship date, for any reason.

## What's not covered

- Kits older than 30 days from ship date.
- Subscription fees for months a kit was successfully delivered,
  opened, and kept past 30 days.

Pausing or canceling stops future kits immediately — no refund
needed, no charge for skipped months.
`;

// Order matters at write time only for attachments (position is
// explicit); document and collection arrays are written sequentially
// in the order below.
export const EXAMPLE_DOCS: readonly ExampleDoc[] = [
  {
    slug: "refund-policy",
    title: "Refund Policy",
    markdown: REFUND_POLICY_MD,
  },
  { slug: "product", title: "Product", markdown: PRODUCT_MD },
  { slug: "brand-voice", title: "Brand Voice", markdown: BRAND_VOICE_MD },
];

export const EXAMPLE_COLLECTIONS: readonly ExampleCollection[] = [
  { slug: "support-agent", name: "Support" },
  { slug: "sales-agent", name: "Sales" },
];

// Collection slugs keep the historical `-agent` suffix (identity:
// the seed + bundle key on it); only the display names dropped it.
export const EXAMPLE_ATTACHMENTS: readonly ExampleAttachment[] = [
  {
    collectionSlug: "support-agent",
    documentSlug: "refund-policy",
    position: 1,
  },
  {
    collectionSlug: "sales-agent",
    documentSlug: "refund-policy",
    position: 1,
  },
  // product before brand-voice so an agent reading the collection
  // meets product details before tone guidance.
  { collectionSlug: "sales-agent", documentSlug: "product", position: 2 },
  { collectionSlug: "sales-agent", documentSlug: "brand-voice", position: 3 },
];

// The agent tier is illustrative — shown in the ghost-preview graph
// only. The seed deliberately does not write agents.
export const EXAMPLE_AGENTS: readonly ExampleAgent[] = [
  { slug: "customer-support-bot", name: "Customer Support Bot" },
  { slug: "cold-outbound-agent", name: "Cold Outbound Agent" },
  { slug: "sales-assistant", name: "Sales Assistant" },
];

export const EXAMPLE_AGENT_LINKS: readonly ExampleAgentLink[] = [
  { collectionSlug: "support-agent", agentSlug: "customer-support-bot" },
  { collectionSlug: "sales-agent", agentSlug: "cold-outbound-agent" },
  { collectionSlug: "sales-agent", agentSlug: "sales-assistant" },
];
