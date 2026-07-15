---
title: CLI
description: A tiny, Git-free pull/push CLI for editing Corpus documents from your terminal or CI — authenticated by an API key and scoped to one collection.
sidebar:
  order: 7
---

The Corpus CLI is a small terminal tool for listing, pulling, and pushing
the documents in **one collection**, using an [API key](./api-keys.md). It
is the way automation edits canonical documents without a browser: a CI job
that regenerates a runbook, a script that syncs docs from another system, or
just you, editing in your own `$EDITOR` instead of the web UI.

Unlike [MCP](./connect-your-agent.md) — which is **read-only**, for agents
consuming collections — the CLI **reads and writes**. It pushes new versions
through the same optimistic-concurrency contract the web editor enforces, so
nothing is ever silently overwritten.

> The CLI is scoped to the **one collection** its API key is bound to. It
> can only see and edit that collection's documents — never the rest of the
> project.

## Install and setup

Install the standalone package, then run the guided setup once:

```sh
npm install --global @nicia-ai/corpus-cli
corpus setup
```

The packaged CLI requires Node.js 22 or newer.

`setup` asks for the Corpus URL and API key (the key is masked), verifies the
connection, then writes a private `0600` config file under
`$XDG_CONFIG_HOME/corpus/config.json` (normally
`~/.config/corpus/config.json`). On Windows it uses
`%LOCALAPPDATA%\\Corpus\\config.json` and relies on Windows ACLs rather than
POSIX mode bits. Use `CORPUS_CONFIG` to choose another path.

Confirm the whole local path is healthy at any time:

```sh
corpus doctor
```

Doctor checks configuration permissions, key format, working-directory
writability, authentication, server reachability, and how many documents the
credential can see.

For a non-interactive setup (for example, a development container), inject the
key through the environment so it does not land in shell history:

```sh
CORPUS_API_KEY="cck_…" corpus setup --url "https://corpus.example.com"
```

The CLI also accepts environment variables. They override saved configuration,
which is convenient in CI:

The CLI needs two environment variables:

| Variable         | Value                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| `CORPUS_URL`     | Your Corpus base URL, e.g. `https://corpus.example.com`.                 |
| `CORPUS_API_KEY` | A `cck_…` key minted by a project owner (see [API keys](./api-keys.md)). |

```sh
export CORPUS_URL="https://corpus.example.com"
export CORPUS_API_KEY="cck_…"
```

From a Corpus source checkout, `pnpm corpus` remains an equivalent development
entry point:

```sh
pnpm corpus <setup|doctor|list|pull|push> …
```

It is a thin wrapper over the REST endpoints documented [below](#rest-api) —
if you'd rather call those directly from CI or `curl`, you can.

## Commands

### `list`

List the documents in the bound collection, one per line as
`slug`, version, and title:

```sh
$ corpus list
api-style-guide   v4   API Style Guide
deploy-runbook    v2   Deploy Runbook
```

Only the collection's members appear — this is the same scope an agent sees
over MCP.

### `pull <slug> [path]`

Download a document's current markdown to a local file (default
`<slug>.md`):

```sh
$ corpus pull api-style-guide
pulled api-style-guide (v4) → api-style-guide.md
```

Alongside the markdown, `pull` writes a small **version sidecar** —
`api-style-guide.md.corpus.json` — recording the version you fetched. Keep
it next to the file; `push` reads it to detect conflicts. Pulling a slug
that isn't in your collection fails with `not found`.

### `push <slug> [path]`

Upload your local edits as a new version (default file `<slug>.md`):

```sh
$ corpus push api-style-guide
pushed api-style-guide → v5
```

`push` sends the version recorded in the sidecar as the version you started
from. If the document has moved on since you pulled, the push is **rejected**
rather than clobbering the newer version:

```sh
$ corpus push api-style-guide
conflict: the document is at v6. Pull, reapply your change, and push again.
```

Pull the current version, reapply your change, and push again. This is the
same conflict contract as the web editor — see
[Versioning & history](./versioning-and-history.md).

On success, `push` updates the sidecar to the new version, so you can keep
editing and pushing without a fresh `pull`.

## The version sidecar

Every pulled file gets a companion `<file>.corpus.json`:

```json
{ "slug": "api-style-guide", "docVersion": 4 }
```

It exists so `push` can do **optimistic concurrency** — "I'm editing version
4; reject me if the server has moved past it." Treat it as a lockfile-style
artifact: leave it beside the markdown, and don't hand-edit it. A file with
**no** sidecar is treated as version 0 — a brand-new document (see below).

## Creating documents

Pushing a slug that doesn't exist yet **creates** it — and adds it to the
collection your key is bound to, so it shows up in `list` and is readable
immediately:

```sh
$ printf '# Onboarding\n\nWelcome…\n' > onboarding.md
$ corpus push onboarding ./onboarding.md
pushed onboarding → v1
```

Because there's no sidecar, the push starts from version 0 and the server
creates version 1.

The CLI syncs the markdown **body**. A new document's title comes from its
content — a `title:` in YAML frontmatter, otherwise the first `# heading`,
otherwise the slug. (The same is true on every push: to control the title
from the CLI, set it in frontmatter or a top-level heading; otherwise manage
it in the web editor.)

## Scope & permissions

An API key is a **Connection** credential, bound to a single collection. The
CLI inherits that scope exactly:

- `list` shows only that collection's documents.
- `pull` of a document outside the collection returns `not found`.
- `push` to a slug that already exists **outside** the collection is
  refused — the key can grow its own collection, never reach into another.

Any project member's key can read and write through it; **minting** keys is
owner-only. Revoke a key the moment it might be exposed — see
[API keys](./api-keys.md).

## A typical loop

```sh
export CORPUS_URL="https://corpus.example.com"
export CORPUS_API_KEY="cck_…"

corpus pull deploy-runbook           # → deploy-runbook.md (+ sidecar)
$EDITOR deploy-runbook.md            # make your changes
corpus push deploy-runbook           # → new version, sidecar updated
```

## REST API

The CLI is a thin client over three endpoints under `/api/v1/docs`. Each
takes the API key as a bearer token and is scoped to the key's collection:

| Method & path            | Does                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| `GET /api/v1/docs`       | List the collection's documents (`slug`, `title`, `docVersion`).   |
| `GET /api/v1/docs/:slug` | Fetch one document's `markdown` + metadata. `404` if not a member. |
| `PUT /api/v1/docs/:slug` | Write a new version. Body: `{ markdown, clientVersion, title? }`.  |

```sh
curl -H "Authorization: Bearer $CORPUS_API_KEY" \
  "$CORPUS_URL/api/v1/docs/api-style-guide"
```

A `PUT` whose `clientVersion` is behind the server returns `409` with the
`currentVersion`; a `PUT` to a slug that exists outside the bound collection
returns `403`. These are exactly the conflict and scope rules the CLI
surfaces above.

## Portability

The `list`/`pull`/`push` logic lives in a runtime-agnostic core
(`cli/core.ts`) with **zero `node:` imports** — it speaks only the web
`fetch` standard and a tiny injected filesystem port:

```ts
type Files = {
  readText: (path: string) => Promise<string | undefined>; // undefined = absent
  writeText: (path: string, data: string) => Promise<void>;
};
```

The published `corpus` binary is the Node shell that wires `node:fs` + `node:process`
to that core. To run the CLI elsewhere — Deno, Bun, a Cloudflare Worker, or
a WASM host — supply your own `fetch` and `Files` adapter and call the same
exported `list`/`pull`/`push`. (The test suite does exactly this: the
worker's `fetch` plus an in-memory file map.)
