---
title: Connect your agent
description: Wire Claude Code, Claude Desktop, Cursor, or VS Code to a specific Corpus — OAuth or API key — and see what tools the agent gets.
sidebar:
  order: 5
---

In Corpus, an agent connects through a **Connection** — a named binding
of one **Project** and exactly one **Corpus**. The Connection is the
agent's entire world: it reads that Corpus's documents and **only**
that Corpus's documents. Switching what an agent sees means editing
the Corpus (or pointing it at a different Connection), not the
credential.

The fastest path is **"Connect agent"** on a Home corpus card, or
**"Connect this corpus"** on a Corpus page — that creates (or reuses)
the Connection and shows an OAuth snippet (or `corpus mcp add`). On
first agent sign-in you land on the Connection picker; the corpus you
just chose is pre-selected — confirm it, then consent.

## Two ways to authenticate

| Method                  | Use it for                                                          | What you store                                                                 |
| ----------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **OAuth** (recommended) | Clients with built-in sign-in, like Claude Code and Claude Desktop. | Nothing — the client runs a sign-in + Connection-picker flow on first connect. |
| **API key**             | Scripts, CI, or agents that can't do an OAuth flow.                 | A bearer token bound to one Connection (see [API keys](./api-keys.md)).        |

Either way, the credential reaches **only** the Connection's bound
Corpus. Documents in other Corpora — or in the same Project but not
attached to this Corpus — are not reachable.

## Client setup

Use a **per-Connection local server name** in every client: `corpus-<corpus>`
(e.g. `corpus-marketing`, `corpus-hr`). If you connect two Corpora from
one client, two distinctly-named entries are the only way to keep their
sign-ins from overwriting each other.

### Claude Code

```bash
claude mcp add \
  --transport http \
  corpus-<corpus> \
  https://your-corpus-host/mcp
```

Then run `/mcp` inside Claude Code and complete the browser sign-in the
first time. You'll pick a Corpus once (pre-selected if you started from
**Connect this corpus**), then consent. For API-key auth, add
`--header "Authorization: Bearer <YOUR_API_KEY>"` and skip the consent
step (the key is already bound to a Connection).

Or let the CLI write the entry:

```bash
corpus mcp add --client claude-code --name corpus-<corpus>
```

### Claude Desktop

Add to `claude_desktop_config.json`, then restart the app:

```json
{
  "mcpServers": {
    "corpus-<corpus>": {
      "command": "npx",
      "args": ["mcp-remote", "https://your-corpus-host/mcp"]
    }
  }
}
```

For API-key auth, append `"--header", "Authorization: Bearer <YOUR_API_KEY>"`
to `args`.

### Cursor

Fastest — from a machine with the [CLI](./cli.md) installed:

```bash
corpus mcp add --client cursor --name corpus-<corpus>
```

Or add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "corpus-<corpus>": {
      "url": "https://your-corpus-host/mcp"
    }
  }
}
```

For API-key auth, add `"headers": { "Authorization": "Bearer <YOUR_API_KEY>" }`.

### VS Code

```bash
corpus mcp add --client vscode --name corpus-<corpus>
```

Or add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "corpus-<corpus>": {
      "type": "http",
      "url": "https://your-corpus-host/mcp"
    }
  }
}
```

For API-key auth, add `"headers": { "Authorization": "Bearer <YOUR_API_KEY>" }`.

## What the agent can do

Once connected, the agent has these tools, all scoped to
the Connection's bound Corpus:

| Tool                    | Does                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_collections`      | The Corpus this connection is bound to (a connection targets exactly one).                                                                                                        |
| `read_collection`       | The always-included guidance for the bound Corpus. No `collectionSlug` is needed.                                                                                                 |
| `list_documents`        | The documents in the bound Corpus — path, slug, title, version, size, and a `delivery` field (`"core"` = always-included, `"reference"` = on-demand).                             |
| `read_document`         | Read one document's markdown, verbatim, by `path` or `slug`.                                                                                                                      |
| `read_document_meta`    | Parsed YAML frontmatter for one document in the bound Corpus, by `path` or `slug`.                                                                                                |
| `verify_history`        | Verify a document's (or the bound Corpus's) version chain is intact.                                                                                                              |
| `suggest_edit`          | Propose an edit to a document — or a NEW document (pass a fresh slug/path with `baseDocVersion: 0`). Always a reviewable suggestion a human applies; never an auto-applied write. |
| `get_proposal_result`   | Check one of this caller's proposals for its human outcome, accepted hunks, resulting document version, and optional reviewer note. Other callers' proposals remain invisible.    |
| `await_proposal_review` | Wait up to 25 seconds for one of this caller's open proposals to receive a human decision, returning early when it settles.                                                       |
| `reply_to_proposal`     | Reply inside one of this caller's still-open proposals. It cannot access document comments, resolve feedback, or act on another caller's proposal.                                |

The same data is also exposed as MCP **resources**:
`corpus://<slug>`, `corpus://<slug>/outline`, and
`document://<slug>` — handy for clients that browse resources rather
than call tools. Resources are scoped the same way; you won't see
slugs outside the bound Corpus.

There is **no direct canonical write tool and no search tool**. Agents consume
your canonical corpus; the only thing they can file is a
_proposal_ (`suggest_edit` — an edit, or a new document) that a human
reviews and applies, and retrieval/RAG is deliberately out of scope —
you decide what's in a Corpus, not a similarity score. Bundle
export is the owner path (web UI), never the agent surface.

After `suggest_edit` returns a `suggestionId` and canonical `reviewUrl`, hand
the URL to the reviewer and pass the id to `await_proposal_review`. The wait
returns as soon as a decision or new proposal message lands, or after 25
seconds with `timedOut: true`; the agent can call it again without losing
state. Pass the largest message id already seen as `afterMessageId` so each
wait wakes only for newer feedback. `get_proposal_result` is the
non-waiting form. Outcomes are `open`, `applied`,
`partially_applied`, `rejected`, or `stale`, so an agent can distinguish a
complete acceptance from a human-selected subset and continue from the
resulting canonical version.

Reviewers can also send proposal-scoped messages before deciding. Those
messages appear in `get_proposal_result` and `await_proposal_review` as
`role: "reviewer"` without a user id. The agent can answer with
`reply_to_proposal`, then file a revised proposal with `suggest_edit` if the
requested change warrants one. Only the human reviewer can settle the review;
the reply tool neither resolves feedback nor changes canonical content. A
revised proposal starts a new review thread; the settled predecessor remains an
immutable audit record rather than silently carrying messages into new work.

For anything beyond a small rules-style Corpus, toggle **Always
include** on for the documents the agent must always start from and
leave the rest on-demand. `read_collection` returns the always-included
set; the agent browses `corpus://<slug>/outline` and calls
`read_document` for on-demand documents when relevant. A large
always-include set dilutes the agent's attention and burns its window,
so keep it small (or raise the corpus's always-include budget if
you're feeding a larger context window).

## Edits take effect on the next call

Adding or removing a document from the bound Corpus — or editing one
in place — takes effect on the agent's **next request**. No re-paste,
no reconnect, no token reissue. The Corpus is the live source of
truth.

## Telling the agent to use it

Connecting only makes the tools available. Instruct the agent to use
them — in a prompt, or in the agent's own rules file:

> Work from the corpus corpus you're connected to. Read the
> outline, follow its always-included guidance, and read individual
> on-demand documents when relevant to the task.

You don't need to name the Corpus in the prompt: the connection IS
the Corpus.

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
Corpus:

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
