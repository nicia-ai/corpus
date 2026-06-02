---
title: What is Corpus?
description: A Git-free canonical collection store for the markdown your AI agents read. Write it once, group it into a collection, point your agent at it over MCP.
sidebar:
  order: 1
  label: What is Corpus?
---

Corpus is a shared, Git-free home for the markdown collection your AI agents
need to do good work.

You write documents in a web editor — coding standards, architecture
notes, API conventions, runbooks, product decisions — group them into an
ordered **collection**, and point your agent at that collection over
[MCP](https://modelcontextprotocol.io). Every agent on that collection reads
the same source of truth, and you update it without touching a repo.

## The problem it solves

If you use Claude Code, Cursor, or any MCP-capable agent, you already
have a collection problem:

- The rules your agent should follow live in scattered markdown files,
  Notion pages, Slack threads, and people's heads.
- Each project re-pastes the same conventions into `CLAUDE.md` /
  `.cursorrules`, and they drift apart.
- Non-engineers who own a lot of that knowledge can't easily contribute
  to files behind a Git workflow.
- When the canonical doc changes, nothing tells the agents.

Corpus makes one canonical copy, editable by anyone on your team in a
browser, and serves it to agents on demand. No repo, no copy-paste, no
drift.

## The model

Three concepts, in order:

1. **Document** — one markdown file. It has a stable slug, a title, and
   an append-only version history. Editing it in the browser creates a
   new version; nothing is ever silently overwritten.
2. **Collection** — an ordered list of documents, assembled into a single
   markdown corpus. This is the unit an agent consumes. A document can
   belong to many collections.
3. **MCP endpoint** — one URL per project. An agent that authenticates
   to it can list your collections and read their assembled corpus (and
   individual documents). It is **read-only**: agents consume collections,
   they never write them.

Tenancy is **Organization → Project**. You sign up, name your
organization, and a default project is created for you. Everything —
documents, collections, team, the MCP endpoint — lives inside that project.

## Who it's for

The same person, wearing two hats:

- **Writing collection** — anyone on the team, technical or not, who knows
  how the work should be done. No Git, no PR, just a markdown editor.
- **Consuming collection** — anyone running an agent who wants it to follow
  that knowledge. One config line and the agent has it.

## Where to go next

- New here? Start with the [Quickstart](./quickstart.md) — zero to an
  agent reading your collection in a few minutes.
- Writing docs? See [Documents](./documents.md) and
  [Collections](./collections.md).
- Wiring up an agent? See [Connect your agent](./connect-your-agent.md).
- Working as a team? See [Your team](./team.md).
