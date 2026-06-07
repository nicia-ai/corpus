---
title: FAQ & troubleshooting
description: Common questions about how Corpus works and what to do when an agent can't see your collection.
sidebar:
  order: 11
---

## How is this different from a Git repo of markdown?

No Git workflow. Non-engineers edit in a browser, with versioning and
conflict resolution built in, and agents read it live over MCP — no
clone, no PR, no copy into `CLAUDE.md`, no drift between projects.

## I uploaded a `docs/` folder — can my prompt say `./docs/product-features.md`?

Yes, if you mean the Corpus path and the document is in the agent's
bound Collection. Corpus is not a directory on the agent's disk, so durable
prompts should say to resolve Corpus paths through the Corpus MCP tools.
`read_document` accepts `path: "docs/product-features.md"` as well as a
stable slug. See [Reference Corpus documents by
path](./connect-your-agent.md#reference-corpus-documents-by-path).

## Can an agent change my documents?

No. The MCP surface is **read-only** — there is no write tool. Documents
and collections change only through the web UI, by people. That asymmetry
is the point: your canonical collection can't be silently rewritten by an
agent.

## Is there search / RAG over my documents?

No, by design. You decide what goes in a collection; the agent reads
its always-included documents on every call and browses the on-demand
outline in your order. There's no similarity-ranked retrieval —
collection selection is an editorial decision, not a search result.

## Why is the agent ignoring part of my collection?

Most likely it's an on-demand document and the agent never decided to
pull it. If it should always be loaded, toggle **Always include** on
its row. If the always-included set is over the collection's budget,
the meter will show amber — split the collection or trim what's
always-included (see [Recipes](./recipes.md)). Also confirm the agent
is actually instructed to read the collection, not just connected to
the endpoint.

## What's a Connection?

A **Connection** is a named binding of one Project and exactly one
Collection — the agent-facing credential unit. OAuth grants and API keys
hang off a Connection; the agent reads **only** the Connection's bound
Collection (no other Collections, no other documents in the same project).
Create one with **Connect this collection** on the Collection page.

## My agent connected but can't see anything

- Make sure the Connection's bound Collection has documents attached and
  you saved them. The agent sees **only** that Collection — documents
  elsewhere in the project are not reachable.
- Confirm the agent authenticated — for OAuth clients, complete the
  sign-in **and** the Connection-picker step (in Claude Code, run
  `/mcp`).
- An API key is scoped to one Connection (one Project + one Collection);
  confirm it's the Connection whose Collection holds your documents.

## The OAuth/sign-in prompt never appears

The client needs the bare endpoint and an OAuth-capable transport. Use
the snippet from **Connect your agent** verbatim for your client. If the
client can't do OAuth, use an [API key](./api-keys.md) instead.

## I lost an API key / invite link

Both are shown once. For a key, **Revoke** it and create a new one. For
an invitation, revoke the pending invite and send a fresh one. Nothing
can re-display the original secret.

## Two of us edited the same document — did I lose work?

No. The second save gets a [resolution screen](./versioning-and-history.md)
showing both versions; you choose what to keep. There is no silent
overwrite.

## A teammate can't accept their invite

The invite is bound to the email it was sent to — they must sign
up/sign in with that exact address. If it expired or was already used,
an owner sends a new one from the **Team** page.

## Do I manage projects?

You get one project per organization automatically; the project
selector only appears if you ever have more than one. Documents,
Collections, Connections, the MCP endpoint, and the team all live inside
that project. Agents connect to a **Collection** within the project (via
a Connection), not to the project as a whole.

## Can I get my data out?

Always. Export a portable JSON bundle of the whole project from the
web UI (**Settings → Export**). Bundle export is an owner action — it
is **not** on the agent's MCP surface (agents can only read the
Collection they're bound to, by design).

## Is it open source?

Yes — Apache-2.0, with the full feature set (multi-tenancy, versioning,
team management, the portable bundle, MCP). No gated edition, no license
key. "Corpus" and "Nicia" are reserved trademarks and aren't licensed by
Apache-2.0.
