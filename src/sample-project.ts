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
// via asDocumentSlug / asCorpusSlug at write time.

// Every document belongs to exactly one corpus.
export type ExampleDoc = Readonly<{
  slug: string;
  title: string;
  markdown: string;
  corpusSlug: string;
}>;

export type ExampleCorpus = Readonly<{
  slug: string;
  name: string;
  description: string;
}>;

export type ExampleAgent = Readonly<{ slug: string; name: string }>;

export type ExampleAgentLink = Readonly<{
  corpusSlug: string;
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

const SUPPORT_PLAYBOOK_MD = `# Support Playbook

How the support desk answers Marlow customers. Company-wide facts —
the product, the refund policy, the brand voice — live in the company
corpus; this corpus holds only what is specific to support.

## First reply

Answer within one business day. Lead with what happens next, not with
an apology.

## Escalate when

- A kit arrived damaged twice in a row.
- A customer asks for a refund outside the 30-day window.
- Anything involving a payment dispute.

Escalations go to the support lead with the order number and the
customer's own words.
`;

const COMPANY_CORPUS = "company";
const SUPPORT_CORPUS = "support-desk";

// Two corpora, one audience each: what the whole company knows, and what
// one team works from. An agent that needs both connects to both — no
// page sits in two corpora.
export const EXAMPLE_COLLECTIONS: readonly ExampleCorpus[] = [
  {
    slug: COMPANY_CORPUS,
    name: "Company",
    description: "What every Marlow agent should know.",
  },
  {
    slug: SUPPORT_CORPUS,
    name: "Support desk",
    description: "How the support team works.",
  },
];

export const EXAMPLE_DOCS: readonly ExampleDoc[] = [
  {
    slug: "refund-policy",
    title: "Refund Policy",
    markdown: REFUND_POLICY_MD,
    corpusSlug: COMPANY_CORPUS,
  },
  {
    slug: "product",
    title: "Product",
    markdown: PRODUCT_MD,
    corpusSlug: COMPANY_CORPUS,
  },
  {
    slug: "brand-voice",
    title: "Brand Voice",
    markdown: BRAND_VOICE_MD,
    corpusSlug: COMPANY_CORPUS,
  },
  {
    slug: "support-playbook",
    title: "Support Playbook",
    markdown: SUPPORT_PLAYBOOK_MD,
    corpusSlug: SUPPORT_CORPUS,
  },
];

// The agent tier is illustrative — shown in the ghost-preview graph
// only. The seed deliberately does not write agents. The support bot
// connects to both corpora: that is how knowledge reaches two audiences.
export const EXAMPLE_AGENTS: readonly ExampleAgent[] = [
  { slug: "customer-support-bot", name: "Customer Support Bot" },
  { slug: "cold-outbound-agent", name: "Cold Outbound Agent" },
  { slug: "sales-assistant", name: "Sales Assistant" },
];

export const EXAMPLE_AGENT_LINKS: readonly ExampleAgentLink[] = [
  { corpusSlug: COMPANY_CORPUS, agentSlug: "customer-support-bot" },
  { corpusSlug: SUPPORT_CORPUS, agentSlug: "customer-support-bot" },
  { corpusSlug: COMPANY_CORPUS, agentSlug: "cold-outbound-agent" },
  { corpusSlug: COMPANY_CORPUS, agentSlug: "sales-assistant" },
];
