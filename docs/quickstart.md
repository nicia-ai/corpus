---
title: Quickstart
description: From a fresh account to an agent reading your canonical corpus — in about five minutes.
sidebar:
  order: 2
---

This walks you from a fresh account to Claude Code reading your canonical
corpus. About five minutes. Prefer not to author anything yet? Skip
to [the built-in example](#start-from-the-built-in-example-instead).

## 1. Create your account

On the sign-up page, enter your **Name**, **Email**, and **Password**,
then **Create account**.

## 2. Name your organization

The first time you sign in you're asked for an **organization name**.
This is your team's container. Corpus creates one default **project**
inside it automatically — that's where your documents, corpora, and the
MCP endpoint live. You won't see a project selector unless you ever have
more than one.

## 3. Write your first document

Go to **Documents → Document** (the **+** button). Give it a **Title**
and write **Markdown** in the body. For example:

```markdown
# Backend conventions

- All HTTP input is validated with Zod at the boundary.
- Errors extend AppError; never throw raw strings.
- Prefer async/await; no floating promises.
```

Click **Create**. The title becomes a stable slug
(`backend-conventions`), and this is version 1. The page starts in
**Drafts**, the unpublished space, so agents can't see it yet.

## 4. Build a corpus

Go to **Corpora → Corpus**. Give it a **Name** (e.g.
`backend-agent`) and an optional **Description**, then **Create
corpus**.

Now publish the document: open it, choose **Move**, and pick
`backend-agent`. The document belongs to that corpus from then on,
under the corpus's root. Its path inside the corpus is the path you
give it. See [Corpora](./corpora.md) for folders, moving documents
between corpora, and deleting a corpus.

## 5. Connect this corpus

On the corpus page, click **Connect this corpus**. Corpus creates (or
reuses) the Connection for this corpus and shows the setup snippet. The
agent will reach **only** this corpus — no documents in Drafts, and none
in other corpora.

Use a per-Connection local server name so multiple Corpora from the
same client don't overwrite each other:

```bash
claude mcp add \
  --transport http \
  --scope project \
  corpus-backend-agent \
  https://your-corpus-host/mcp
```

`--scope project` writes the connection to a `.mcp.json` file at your
repo root, so it's committed and shared with everyone who works in that
repo — the right choice when a whole team's agents should read the same
Corpus. The other scopes are `local` (the default: private to you,
this directory only) and `user` (available to you across all your
projects). Drop the flag to keep the connection to yourself.

Run it in your terminal. In Claude Code, run `/mcp` and complete the
sign-in. The consent screen asks which Corpus to grant — pick
`backend-agent` (Corpus pre-selects the one you just clicked Connect
on). The agent now reads exactly that Corpus's documents and nothing
else.

## 6. Use it

Ask your agent to use it. For example, in Claude Code:

> Work from the corpus you're connected to. List its documents, and
> read the ones the task needs.

The agent lists the corpus's documents with `list_documents`, then reads
the ones relevant to the task with `read_document`. Edit a document in
Corpus and the agent picks up the new version on its **next call** — no
re-paste, no reconnect.

## Start from the built-in example instead

Don't want to author a document first? On an empty project, the home
screen offers **Load our example** — click it to populate the project
with demo data for a fictional subscription product (Marlow), including
two ready-made corpora, **Company** and **Support desk**.

Connect the **Company** corpus exactly as in step 5 (use a server name
like `corpus-company`), then smoke-test it:

> What documents are in my Company corpus?

You should see something like:

> Your Company corpus contains 3 documents:
>
> - policies/refunds.md — Refund Policy
> - product.md — Product
> - brand-voice.md — Brand Voice

Then put the corpus to work — the point is that the agent treats it
as the source of truth, not just a file listing:

> Using only the guidance in my Company corpus, draft a cold outreach
> email to a 34-year-old pediatric nurse who joined the Marlow waitlist
> last month but hasn't subscribed yet.

To give a support agent both the company rules and the support playbook,
connect it to the **Company** and **Support desk** corpora. See
[Connect your agent](./connect-your-agent.md).

## Next steps

- [Documents](./documents.md) — frontmatter, versions, conflict
  resolution, importing existing markdown.
- [Corpora](./corpora.md) — drafts, moving documents between corpora,
  and what the agent actually receives.
- [Connect your agent](./connect-your-agent.md) — Claude Desktop,
  Cursor, VS Code, and API-key auth for non-OAuth clients.
- [Recipes](./recipes.md) — patterns that work well in practice.
