---
title: Recipes & best practices
description: Patterns that make Corpus pay off — designing corpora agents actually follow, keeping docs agent-readable, and wiring it into your workflow.
sidebar:
  order: 11
---

Corpus is simple on purpose. The leverage is in _how_ you structure
your corpora. These are patterns that work in practice.

## Design corpora around an audience, not a topic

A corpus is "what this kind of agent should know," not "everything
about X." Name them for the reader:

- `backend-agent` — conventions, error model, testing rules.
- `release-reviewer` — the checklist a PR-review agent applies.
- `support-bot` — product facts and tone for a customer-facing agent.

Each document lives in exactly one corpus, so don't copy a document
per audience. Shared knowledge (say `error-handling`) goes in its own
corpus, and each agent connects to every corpus it needs. A
`backend-agent` connected to `company` and `backend-agent` reads both.
See [Corpora](./corpora.md#sharing-knowledge-between-corpora).

## Keep each corpus focused

A corpus is a drive for one kind of reader. When one grows past what
that reader needs, split it by task (`backend-agent-writing` vs
`backend-agent-reviewing`), and move documents between corpora from the
Corpus page. Moving takes effect on the agent's next request, and the
history of each document moves with it.

Name documents so the list reads well. The agent sees every path in
alphabetical order, so a folder per topic (`policies/refunds.md`,
`policies/returns.md`) makes the list easy to scan.

## Write documents for an agent reader

- One clear `# H1` per document; explicit imperative rules ("Always
  validate input with Zod at the boundary") beat prose.
- State the rule _and_ the rationale — agents follow rules they
  understand better than bare edicts.
- Avoid implicit context ("as discussed last sprint"). The agent has
  only what's in the corpus.
- Link related documents by relative path; the editor flags broken links.
  An agent that follows a link reads the target with `read_document`.

## Use frontmatter as a control surface

Put `status`, `owner`, `audience` in [frontmatter](./documents.md).
It never changes the file the agent reads, but an agent can call
`read_document_meta` and skip or downweight a doc marked
`status: draft`. Good for staging changes before they're authoritative.

## Wire it into the agent durably

Don't rely on remembering to say "read the corpus." Put it in the
agent's standing instructions:

- **Claude Code** — add a line to `CLAUDE.md`: _"At the start of any
  task, work from the corpus you're connected to: list its documents,
  and read `docs/error-handling.md` when the task touches errors."_
- **Cursor / others** — the equivalent rules file.

You can name a specific document by its corpus path — _"read
`docs/error-handling.md` from Corpus"_ — and the agent will pull just
that one within the Connection's bound Corpus. Naming the documents that
matter in standing instructions keeps prompts precise and tells the agent
what to read first.

Now every session starts from your canonical corpus, and updating it in
Corpus updates every agent on the next read — no redeploy, no re-paste.

## Edit fearlessly

Nothing is lost: every save is a new version, concurrent edits get a
[resolution screen](./versioning-and-history.md), and you can verify
the chain. Non-engineers should edit directly — that's the workflow
Corpus exists to enable. Treat the [changes feed](./versioning-and-history.md)
as the "what moved" check before a consequential agent run.

## Co-write one page with several agents

When two people each run their own agent against the same page — an event
plan, a launch checklist — make one [share link](./share-a-page.md) per
person and name it for them ("Dana's Claude Code"). Tell each agent which
section is theirs and have it use the section write
(`PUT /s/<token>/section?heading=…`) rather than rewriting the whole page:
a section write lands even when someone else edited a different section
since the agent last read. The prompt already tells the agent to save the
link in its project instructions, so a page that changes over days (an RSVP
list, a status table) stays editable from later sessions. Set the link to
no expiry for a long-running page, and switch it to Suggest when you want to
review changes before publishing.

## Separate stable from fast-moving

Keep rarely-changing knowledge (`engineering-principles`) in a corpus
that every relevant agent connects to. Volatile specifics
(`q3-migration-plan`) belong in the corpus of the team doing that work.
When the work is done, move the document into Drafts, or into an archive
corpus, without deleting its history.
