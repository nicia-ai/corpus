---
title: Corpora
description: Grouping documents into an ordered corpus — the unit an agent reads as one corpus — plus the per-corpus always-include budget and what the agent actually receives.
sidebar:
  order: 4
---

A **corpus** is an ordered set of documents assembled into one markdown
corpus. It is the unit an agent reads. Point every agent that should
share a body of knowledge at the same corpus and they all see the same
source of truth.

## Creating a corpus

**Corpora → Corpus**. Give it a **Name** and an optional
**Description**, then **Create corpus**. The name becomes the slug an
agent uses to address it (e.g. `read_collection` with `backend-agent`).

Pick names by _who reads it_, not by topic — `backend-agent`,
`support-bot`, `release-reviewer`. One document can sit in many
corpora, so you don't duplicate content to serve different audiences.

## Adding and ordering documents

On the corpus page:

- **Add documents** — search by title, filename, or path and click **Add**.
  Added documents land on-demand by default: they're listed in the
  corpus's outline and the agent pulls them by path when relevant.
- **Add folders** — add a whole folder the same way; new documents in
  that folder join automatically.
- **Always include** — toggle the switch on a document (or folder) row
  to pre-load it into every `read_collection` call. Use this for the
  small set of guidance an agent should always start from (brand voice,
  policy constraints, architecture rules).
- **Reorder** — drag the handle on a row. Order is the sequence in the
  assembled corpus and the order the agent sees in the outline, so put
  the most important framing first.
- **Detach** — the remove button on a row removes the document from this
  corpus. The document itself is untouched and stays in any other
  corpus.

The mental default is "on demand." Promote a document to **Always
include** only when the agent should not have to choose whether to read
it.

## Always-include budget

Each corpus has its own **always-include budget** (default
**8,000 tokens**, configurable per corpus in **Edit**). The header
shows the always-included document count and an estimated total token
size compared against that budget. Past the budget the meter turns
amber.

The budget is **authoring-side guidance only** — `read_collection`
still ships every document you've marked Always include, regardless of
size. The meter is there so you see the cost of what you've configured
before an agent does. Raise the budget for corpora feeding a larger
context window; lower it to keep a corpus lean.

A bloated always-include set dilutes the agent's attention and burns
its window. Prefer several focused corpora over one
everything-corpus. See [Recipes](./recipes.md) for how to split.

## What the agent actually receives

`read_collection` returns the **Always include** documents concatenated
**in your order** as one markdown string, at each document's current
version, plus a provenance manifest.

The remaining (on-demand) documents are exposed through the structured
**outline** — the `corpus://<slug>/outline` resource: the document
list with derived paths and a resolved link graph. The agent reads
individual on-demand documents with `read_document` as it needs them,
rather than ingesting everything at once.

A Connection is bound to exactly one Corpus, so the agent does not
need to pass a `corpusSlug`; the bound Corpus is the scope. The
credential cannot read documents outside that Corpus.

## Editing a corpus

Use **Edit** on the corpus page to change its name, description, or
**always-include budget**. Attaching, detaching, reordering, or
toggling Always include on individual documents takes effect on the
next read — there's nothing to publish or deploy. Update a document and
every corpus containing it serves the new version immediately.
