---
title: CLI
description: A tiny pull/push CLI for editing Corpus documents from your terminal or CI — authenticated by an API key and scoped to one corpus.
sidebar:
  order: 7
---

The Corpus CLI is a small terminal tool for listing, pulling, and pushing
the documents in **one corpus**, using an [API key](./api-keys.md). It
is the way automation edits canonical documents without a browser: a CI job
that regenerates a runbook, a script that syncs docs from another system, or
just you, editing in your own `$EDITOR` instead of the web UI.

Unlike [MCP](./connect-your-agent.md) — whose only write is a human-reviewed
proposal — the CLI **reads and writes canonical documents**. That is why it
deliberately uses the corpus-scoped REST API and an API key instead of the
MCP/OAuth transport. It pushes new versions through the same
optimistic-concurrency contract the web editor enforces, so nothing is ever
silently overwritten.

> The CLI is scoped to the **one corpus** its API key is bound to. It
> can only see and edit that corpus's documents — never the rest of the
> project.

## Install and setup

Install the standalone package, then run the guided setup once:

```sh
npm install --global @nicia-ai/corpus-cli
corpus setup
```

The packaged CLI requires Node.js 22 or newer.

`setup` defaults to `https://corpus.nicia.ai` and asks only for the API key
(masked), verifies the connection, then writes a private `0600` config file under
`$XDG_CONFIG_HOME/corpus/config.json` (normally
`~/.config/corpus/config.json`). On Windows it uses
`%LOCALAPPDATA%\\Corpus\\config.json` and relies on Windows ACLs rather than
POSIX mode bits. Self-hosters pass `--url`; use `CORPUS_CONFIG` to choose
another config path.

Confirm the whole local path is healthy at any time:

```sh
corpus doctor
```

Doctor reports the installed CLI version and checks configuration permissions,
key format, working-directory writability, authentication, server reachability,
and how many documents the credential can see.

For a non-interactive setup (for example, a development container), inject the
key through the environment so it does not land in shell history:

```sh
CORPUS_API_KEY="cck_…" corpus setup --url "https://corpus.example.com"
```

The CLI also accepts environment variables. They override saved configuration,
which is convenient in CI:

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
pnpm corpus <setup|doctor|mcp|list|pull|push> …
```

It is a thin wrapper over the REST endpoints documented [below](#rest-api) —
if you'd rather call those directly from CI or `curl`, you can.

## Commands

### `mcp add`

Write an OAuth MCP server entry for Cursor, Claude Code, or VS Code — the
fast path after **Connect this corpus** in the UI. No API key required;
the agent completes browser sign-in on first use.

```sh
corpus mcp add --client cursor --name corpus-default
corpus mcp add --client claude-code --name corpus-marketing
corpus mcp add --client vscode --url https://corpus.example.com --name corpus-ops
```

| Flag       | Default                                            | Notes                                                                                                                                   |
| ---------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--client` | `cursor`                                           | `cursor` writes `~/.cursor/mcp.json`; `vscode` writes `.vscode/mcp.json` in the cwd; `claude-code` prints the `claude mcp add` command. |
| `--url`    | `$CORPUS_URL/mcp` or `https://corpus.nicia.ai/mcp` | Hosted or self-hosted MCP endpoint.                                                                                                     |
| `--name`   | `corpus-default`                                   | Local MCP server name — use `corpus-<slug>` to match the UI.                                                                            |

### `list`

List the documents in the bound corpus, one per line as
`slug`, version, and title:

```sh
$ corpus list
api-style-guide   v4   API Style Guide
deploy-runbook    v2   Deploy Runbook
```

Only the documents in the corpus appear — this is the same scope an agent
sees over MCP. A document that is moved to another corpus or to Drafts, or
archived, drops out of the list.

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
that isn't in your corpus fails with `not found`.

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

### `pull --all [dir] [--overwrite]`

Write the **whole corpus** into a directory (default: the current directory),
one file per document, at the document's path in the corpus (relative to the corpus root, the way an
agent sees it), creating folders as
needed and preserving each file's bytes exactly (including a missing trailing
newline and CRLF line endings). The directory can be anywhere: Corpus assumes
nothing about what surrounds it, and the files are an ordinary folder tree.

```sh
$ corpus pull --all ./agent-docs
added 2, updated 1, removed 0, unchanged 5
+ runbooks/deploy.md
+ style/api.md
~ readme.md
```

It is built to be run repeatedly (see [keeping a repository in sync from
CI](#keep-a-repository-in-sync-from-ci)):

- **Idempotent.** With nothing new upstream, a run writes nothing (not even the
  state file), prints `up to date: N files in <dir>`, and exits `0`.
- **Tracks only what it wrote.** Documents that left the corpus (moved to another corpus or to
  Drafts, or archived) are deleted locally, and renamed or moved documents are moved, but only files recorded in
  the [state file](#the-sync-state-file). Other files in the directory are never
  touched. Folders left empty by a removal or move are not deleted.
- **Cheap.** Unchanged documents (same version, same path) are not downloaded.
- **Safe paths.** A document path that is absolute, contains `..`, `\`, or a
  `.git` segment, or that collides with another path on a case-insensitive
  filesystem is refused before anything is written (exit `1`).
- **Do-nothing on failure.** Everything is fetched before the first write, so a
  network or auth error leaves the directory as it was.

Output is plain text, one path per line under the counts. There is no
machine-readable mode; the exit code is the contract:

| Exit | Meaning                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------- |
| `0`  | Success, including "up to date" and locally edited files that were kept (see below).                          |
| `1`  | Any other error: bad usage, missing config, unsafe path, a state file that is invalid or for another corpus.  |
| `2`  | Conflicts: some local edits would have been overwritten and were left untouched. Everything else was applied. |
| `3`  | Transport or auth error: the server was unreachable or refused the key.                                       |

#### Local edits are never lost

Before overwriting or deleting a tracked file, `pull --all` compares its bytes
to the hash recorded when it last wrote the file:

| Situation                                                   | Result                                          |
| ----------------------------------------------------------- | ----------------------------------------------- |
| Edited locally, upstream unchanged                          | Left alone and listed as `kept`. Exit `0`.      |
| Edited locally, upstream changed (update, move, or removal) | **Conflict**: left untouched, listed, exit `2`. |
| Untracked file at a path the corpus wants, different bytes  | **Conflict**: left untouched, listed, exit `2`. |
| Untracked file at that path with identical bytes            | Adopted into the state file; not a conflict.    |
| Tracked file deleted locally, upstream unchanged            | Restored.                                       |

Non-conflicting files are still applied in the same run. To resolve a conflict,
keep a copy of your version, run `corpus pull <slug> <path>` to take upstream's,
reapply your edit, and `corpus push <slug> <path>`. Or re-run with
`--overwrite`, which makes the directory match the corpus: it replaces every
conflicting or locally edited file and deletes edited files that were removed
upstream. Local edits are discarded, so commit or copy anything you want first.

## The sync-state file

`pull --all` records what it wrote in a single dotfile at the root of the
directory, `.corpus.json`:

```json
{
  "version": 1,
  "corpus": { "projectId": "…", "slug": "ops" },
  "files": [
    {
      "path": "runbooks/deploy.md",
      "slug": "deploy-runbook",
      "docVersion": 4,
      "sha256": "…"
    }
  ]
}
```

`slug` is the stable document identifier the REST API uses; it survives
renames and moves. `sha256` is the hash of the bytes written. The file is
serialized deterministically (fixed key order, files sorted by path, trailing
newline), so committing it produces clean diffs, and it is rewritten only when
something changed. Commit it alongside the documents: it is what lets the next
run tell your edits from upstream's. A directory whose `.corpus.json` belongs to a
different corpus is refused, so two corpora never mix; use one directory per
corpus. Don't hand-edit it.

**Relationship to the per-file sidecar.** Inside a `pull --all` directory the
state file replaces the sidecar. Single-document `push <slug> <path>` and
`pull <slug> <path>` on a tracked file read and update that file's entry in
`.corpus.json` instead of writing a per-file sidecar, so the two
never disagree. Files outside such a directory keep using sidecars exactly as
before. (A file that already has a sidecar keeps using it.)

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

Pushing a slug that doesn't exist yet **creates** it — inside the corpus your
key is bound to, at its top level, so it shows up in `list` and is readable
immediately. (Move it into a folder afterwards from the web app. Over the
[REST API](#rest-api) a create can also name a corpus-relative `path`.)

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

An API key is a **Connection** credential, bound to a single corpus. The
CLI inherits that scope exactly:

- `list` shows only that corpus's documents.
- `pull` of a document outside the corpus returns `not found`.
- `push` to a slug that already exists **outside** the corpus is
  refused — the key can grow its own corpus, never reach into another.

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

## Keep a repository in sync from CI

Teams often keep markdown for their agents in a git repository. Corpus is where
teammates edit; a scheduled job writes the corpus into the repository and
commits what changed. Nothing about the repository layout is assumed: pick any
directory. These steps work in any CI system:

```sh
npm install --global @nicia-ai/corpus-cli

# CORPUS_URL and CORPUS_API_KEY come from the CI system's secret store.
corpus pull --all agent-docs        # exit 2 = a local edit blocked an update

git add agent-docs
if ! git diff --cached --quiet; then
  git commit -m "Sync from Corpus"
  git push
fi
```

Run it on a schedule. When nothing changed upstream the pull writes nothing,
`git diff --cached` is empty, and no commit is made. Keep the CI job's
exit-code handling: `2` means someone edited a synced file in the repository
and upstream also changed it. The job stops (most CI systems stop on a non-zero
exit) so a person can resolve it; the files that could be updated were. Use one
API key per corpus and one directory per corpus.

In GitHub Actions, paste the same steps into a workflow job after checkout
and Node setup (set `CORPUS_URL` and `CORPUS_API_KEY` from secrets):

```yaml
- run: npm install --global @nicia-ai/corpus-cli
- run: corpus pull --all agent-docs
  env:
    CORPUS_URL: ${{ secrets.CORPUS_URL }}
    CORPUS_API_KEY: ${{ secrets.CORPUS_API_KEY }}
- run: |
    git add agent-docs
    git diff --cached --quiet || {
      git -c user.name=corpus-sync -c user.email=corpus-sync@users.noreply.github.com commit -m "Sync from Corpus"
      git push
    }
```

This only copies the corpus's current files into the repository. It does not
push edits made in the repository back to Corpus (use `corpus push` for that),
and Corpus does not mirror or write to git itself.

## REST API

The CLI is a thin client over three endpoints under `/api/v1/docs`. Each
takes the API key as a bearer token and is scoped to the key's corpus:

| Method & path            | Does                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/docs`       | List the corpus's documents (`slug`, `title`, `docVersion`, `path`) plus the `corpus` identity (`projectId`, `slug`).         |
| `GET /api/v1/docs/:slug` | Fetch one document's `markdown` + metadata. `404` if it is not in the corpus.                                                 |
| `PUT /api/v1/docs/:slug` | Write a new version. Body: `{ markdown, clientVersion, title?, path? }`; `path` (corpus-relative) only places a NEW document. |

```sh
curl -H "Authorization: Bearer $CORPUS_API_KEY" \
  "$CORPUS_URL/api/v1/docs/api-style-guide"
```

A `PUT` whose `clientVersion` is behind the server returns `409` with the
`currentVersion`. An update (`clientVersion` above 0) of a document that is not
in the bound corpus — including one that was moved out — returns `404`, the
same as a slug that does not exist. Creating a slug already taken outside the
corpus returns `403`, and a `path` that leaves the corpus (`..`, an absolute
path, `\`) returns `400`. A key can never read or write a document outside its
corpus, Drafts included. These are the conflict and scope rules the CLI
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
