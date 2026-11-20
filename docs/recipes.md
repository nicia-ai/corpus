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

Knowledge every agent needs (say `error-handling`) belongs in a corpus of
its own — `company` or `engineering` — that agents connect to alongside
their own. Many teams already work this way, with a company repository
beside each project repository. Keep each document in one place; don't
fork it per audience.

## Keep the always-include set lean

Each corpus has its own always-include budget (default 8,000
tokens; raise it per corpus if you're feeding a larger context
window). Past the budget the meter warns — a bloated always-include set
dilutes the agent's attention and burns the window before it does any
work. On-demand documents stay in `collection://<slug>/outline` and are
pulled by path only when relevant.

When a corpus gets heavy:

- Split it by task (`backend-agent-writing` vs `backend-agent-reviewing`).
- Move rarely-needed detail to on-demand (toggle Always include off).
- Lead with the most important framing first — it's what the agent sees
  before it decides what else to pull.

"Always-include these few, plus a big on-demand library" is the common
shape: toggle Always include on for the small set the agent must
internalize, leave the rest on-demand. Both live in the same Corpus
and the agent sees the outline of all of them.

## Write documents for an agent reader

- One clear `# H1` per document; explicit imperative rules ("Always
  validate input with Zod at the boundary") beat prose.
- State the rule _and_ the rationale — agents follow rules they
  understand better than bare edicts.
- Avoid implicit context ("as discussed last sprint"). The agent has
  only what's in the corpus.
- Link related documents by relative path; the editor flags broken links and
  agents can traverse the resolved link graph via the corpus outline.

## Use frontmatter as a control surface

Put `status`, `owner`, `audience` in [frontmatter](./documents.md).
It never changes the file the agent reads, but an agent can call
`read_document_meta` and skip or downweight a doc marked
`status: draft`. Good for staging changes before they're authoritative.

## Wire it into the agent durably

Don't rely on remembering to say "read the corpus." Put it in the
agent's standing instructions:

- **Claude Code** — add a line to `CLAUDE.md`: _"At the start of any
  task, work from the corpus you're connected to: read its
  always-included guidance, browse its outline, and read
  `docs/error-handling.md` when the task touches errors."_
- **Cursor / others** — the equivalent rules file.

You can name a specific document by Corpus path — _"read
`docs/error-handling.md` from Corpus"_ — and the agent will pull just
that one within the Connection's bound Corpus. Naming on-demand
documents in standing instructions is how you keep prompts precise
without bloating the always-include set.

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

Keep a small, rarely-changing core (`engineering-principles`) in a corpus
of its own that many agents connect to, and put volatile specifics
(`q3-migration-plan`) in the project corpus where they are relevant.
Archive them when the work is done; the history stays.
