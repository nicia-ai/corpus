---
title: Connect your agent
description: Wire Claude Code, Claude Desktop, Cursor, or VS Code to a specific Collection — OAuth or API key — and see what tools the agent gets.
sidebar:
  order: 5
---

In Corpus, an agent connects through a **Connection** — a named binding
of one **Project** and exactly one **Collection**. The Connection is the
agent's entire world: it reads that Collection's documents and **only**
that Collection's documents. Switching what an agent sees means editing
the Collection (or pointing it at a different Connection), not the
credential.

The fastest path is **"Connect this collection"** on the Collection page —
that creates (or reuses) the Connection for that Collection and shows you
the setup snippet.

## Two ways to authenticate

| Method                  | Use it for                                                          | What you store                                                                 |
| ----------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **OAuth** (recommended) | Clients with built-in sign-in, like Claude Code and Claude Desktop. | Nothing — the client runs a sign-in + Connection-picker flow on first connect. |
| **API key**             | Scripts, CI, or agents that can't do an OAuth flow.                 | A bearer token bound to one Connection (see [API keys](./api-keys.md)).        |

Either way, the credential reaches **only** the Connection's bound
Collection. Documents in other Collections — or in the same Project but not
attached to this Collection — are not reachable.

## Client setup

Use a **per-Connection local server name** in every client: `corpus-<collection>`
(e.g. `corpus-marketing`, `corpus-hr`). If you connect two Collections from
one client, two distinctly-named entries are the only way to keep their
sign-ins from overwriting each other.

### Claude Code

```bash
claude mcp add \
  --transport http \
  corpus-<collection> \
  https://your-corpus-host/mcp
```

Then run `/mcp` inside Claude Code and complete the sign-in the first
time. The consent screen asks which Collection to grant — pick the one
this agent should see. For API-key auth, add
`--header "Authorization: Bearer <YOUR_API_KEY>"` and skip the consent
step (the key is already bound to a Connection).

### Claude Desktop

Add to `claude_desktop_config.json`, then restart the app:

```json
{
  "mcpServers": {
    "corpus-<collection>": {
      "command": "npx",
      "args": ["mcp-remote", "https://your-corpus-host/mcp"]
    }
  }
}
```

For API-key auth, append `"--header", "Authorization: Bearer <YOUR_API_KEY>"`
to `args`.

### Cursor

Add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "corpus-<collection>": {
      "url": "https://your-corpus-host/mcp"
    }
  }
}
```

For API-key auth, add `"headers": { "Authorization": "Bearer <YOUR_API_KEY>" }`.

### VS Code

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "corpus-<collection>": {
      "type": "http",
      "url": "https://your-corpus-host/mcp"
    }
  }
}
```

For API-key auth, add `"headers": { "Authorization": "Bearer <YOUR_API_KEY>" }`.

## What the agent can do

Once connected, the agent has these **read-only** tools, all scoped to
the Connection's bound Collection:

| Tool                 | Does                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_collections`   | The Collection this connection is bound to (a connection targets exactly one).                                                                            |
| `read_collection`    | The always-included guidance for the bound Collection. No `collectionSlug` is needed.                                                                     |
| `list_documents`     | The documents in the bound Collection — path, slug, title, version, size, and a `delivery` field (`"core"` = always-included, `"reference"` = on-demand). |
| `read_document`      | Read one document's markdown, verbatim, by `path` or `slug`.                                                                                              |
| `read_document_meta` | Parsed YAML frontmatter for one document in the bound Collection, by `path` or `slug`.                                                                    |
| `verify_history`     | Verify a document's (or the bound Collection's) version chain is intact.                                                                                  |

The same data is also exposed as MCP **resources**:
`collection://<slug>`, `collection://<slug>/outline`, and
`document://<slug>` — handy for clients that browse resources rather
than call tools. Resources are scoped the same way; you won't see
slugs outside the bound Collection.

There is **no write tool and no search tool**. Agents consume your
canonical collection; they don't mutate it, and retrieval/RAG is
deliberately out of scope — you decide what's in a Collection, not a
similarity score. Bundle export is the owner path (web UI), never the
agent surface.

For anything beyond a small rules-style Collection, toggle **Always
include** on for the documents the agent must always start from and
leave the rest on-demand. `read_collection` returns the always-included
set; the agent browses `collection://<slug>/outline` and calls
`read_document` for on-demand documents when relevant. A large
always-include set dilutes the agent's attention and burns its window,
so keep it small (or raise the collection's always-include budget if
you're feeding a larger context window).

## Edits take effect on the next call

Adding or removing a document from the bound Collection — or editing one
in place — takes effect on the agent's **next request**. No re-paste,
no reconnect, no token reissue. The Collection is the live source of
truth.

## Telling the agent to use it

Connecting only makes the tools available. Instruct the agent to use
them — in a prompt, or in the agent's own rules file:

> Work from the corpus collection you're connected to. Read the
> outline, follow its always-included guidance, and read individual
> on-demand documents when relevant to the task.

You don't need to name the Collection in the prompt: the connection IS
the Collection.

### Reference Corpus documents by path

Corpus is **not a folder on disk**. Uploading a local `docs/` folder
does not give the agent a `./docs/` directory — each file becomes a
document the agent reads over MCP. Corpus preserves the uploaded path
as a first-class address, so an agent can read `docs/brand-voice.md`
through `read_document` even though there is no local file at that path.

Use an explicit Corpus instruction in durable prompts so filesystem
agents do not look on local disk first:

> Resolve Corpus document paths with the Corpus MCP tools before
> treating them as missing local files.

This prompt works when `docs/product-features.md` is in the bound
Collection:

> You are a cold-outbound authoring agent. Write a personalized message
> to the lead below. Refer to our product features in
> `docs/product-features.md` in Corpus to find features relevant to the
> lead and tailor the message:
>
> Bob Smith — mentioned SCIM and enterprise auth being key features in a
> LinkedIn post.

Now the agent reads your live canonical copy: edit the document in
Corpus and the next run picks it up, with no change to the prompt.

See [Recipes](./recipes.md) for durable ways to wire this in.
