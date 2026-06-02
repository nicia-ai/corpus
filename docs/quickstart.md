---
title: Quickstart
description: From a fresh account to an agent reading your canonical collection — in about five minutes.
sidebar:
  order: 2
---

This walks you from a fresh account to Claude Code reading your canonical
collection. About five minutes. Prefer not to author anything yet? Skip
to [the built-in example](#start-from-the-built-in-example-instead).

## 1. Create your account

On the sign-up page, enter your **Name**, **Email**, and **Password**,
then **Create account**.

## 2. Name your organization

The first time you sign in you're asked for an **organization name**.
This is your team's container. Corpus creates one default **project**
inside it automatically — that's where your documents, collections, and the
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
(`backend-conventions`), and this is version 1.

## 4. Build a collection

Go to **Collections → Collection**. Give it a **Name** (e.g.
`backend-agent`) and an optional **Description**, then **Create
collection**.

On the collection page, use **Add to this collection** to search for the
document you just wrote and click **Add**. Added documents land
**on-demand** — the agent sees them in the outline and pulls them by
path when relevant. If a document should be pre-loaded into every
`read_collection` call (brand voice, a compliance notice, the core
architecture rules), flip its **Always include** switch. Drag the
handle to reorder; that's the sequence the agent sees. See
[Collections](./collections.md) for the always-include budget and
when to split.

## 5. Connect this collection

On the Collection page (where you just attached documents), click
**Connect this collection**. Corpus creates (or reuses) the Connection
for this Collection and shows the setup snippet. The agent will reach
**only** this Collection — no other documents in the project.

Use a per-Connection local server name so multiple Collections from the
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
Collection. The other scopes are `local` (the default: private to you,
this directory only) and `user` (available to you across all your
projects). Drop the flag to keep the connection to yourself.

Run it in your terminal. In Claude Code, run `/mcp` and complete the
sign-in. The consent screen asks which Collection to grant — pick
`backend-agent` (Corpus pre-selects the one you just clicked Connect
on). The agent now reads exactly that Collection's documents and nothing
else.

## 6. Use it

Ask your agent to use it. For example, in Claude Code:

> Work from the corpus collection you're connected to. Read its
> always-included guidance, browse the outline, and pull on-demand
> documents when relevant.

The agent reads the always-included documents with `read_collection`,
browses the Collection's outline, and reads on-demand documents by path
as needed. Edit a document in Corpus and the agent picks up the new
version on its **next call** — no re-paste, no reconnect.

## Start from the built-in example instead

Don't want to author a document first? On an empty project, the home
screen offers **Load our example** — click it to populate the project
with demo data for a fictional subscription product (Marlow), including
two ready-made collections, **Sales** and **Support**.

Connect the **Sales** collection exactly as in step 5 (use a server name
like `corpus-sales`), then smoke-test it:

> What documents are in my Sales collection?

You should see something like:

> Your Sales collection contains 3 documents:
>
> - refund-policy.md — Refund Policy
> - product.md — Product
> - brand-voice.md — Brand Voice

Then put the collection to work — the point is that the agent treats it
as the source of truth, not just a file listing:

> Using only the guidance in my Sales collection, draft a cold outreach
> email to a 34-year-old pediatric nurse who joined the Marlow waitlist
> last month but hasn't subscribed yet.

## Next steps

- [Documents](./documents.md) — frontmatter, versions, conflict
  resolution, importing existing markdown.
- [Collections](./collections.md) — ordering, the always-include
  budget, and what the agent actually receives.
- [Connect your agent](./connect-your-agent.md) — Claude Desktop,
  Cursor, VS Code, and API-key auth for non-OAuth clients.
- [Recipes](./recipes.md) — patterns that work well in practice.
