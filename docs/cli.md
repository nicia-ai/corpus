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

What a key may do is its **grant**, the same `read < suggest < edit` rule a
[share link](./share-a-page.md) carries: a `read` key fetches, a `suggest` key
also sends changes that become **proposals a person reviews**, and an `edit` key
writes canonical documents directly (see [Grants](#grants)). That is why the CLI
uses the corpus-scoped REST API and an API key rather than the MCP/OAuth
transport. Direct writes go through the same optimistic-concurrency contract the
web editor enforces, so nothing is ever silently overwritten.

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

### `push <slug> [file] [--path P]`

Upload your local edits as a new version (default file `<slug>.md`). Needs a
`suggest` or `edit` key. With a `suggest` key the edit is filed as a proposal
instead (see [Grants](#grants)):

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
newline and CRLF line endings). The corpus's [images and
attachments](./files.md) come with it, next to the pages that link them, byte
for byte. The directory can be anywhere: Corpus assumes nothing about what
surrounds it, and the files are an ordinary folder tree.

> **Upgrade the CLI to carry images** (0.2.0 or newer). An older CLI does not
> fail on a corpus with images: it never reads them, so `pull --all` writes only
> the pages and `push --all` reports image files as ignored. It does rewrite
> `.corpus.json` without the image entries, so a checkout shared between old and
> new CLIs loses its image tracking each time the old one runs; the new CLI
> then re-matches the files by their hash and uploads nothing.

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
- **Cheap.** Unchanged documents (same version, same path) are not downloaded,
  and neither is an image whose hash already matches. Images are downloaded one
  at a time.
- **Safe paths.** A document or image path that is absolute, contains `..`,
  `\`, or a `.git` segment, or that collides with another path on a
  case-insensitive filesystem is refused before anything is written (exit `1`).
- **Verified.** Every downloaded image is checked against the hash Corpus
  listed before it touches the disk; bytes that do not match are never written.
- **Do-nothing on failure.** The listing and every document are fetched before
  the first write, so a network or auth error leaves the directory as it was.
  Images are downloaded after the pages are written; if one fails, the pages
  and the images already done are recorded in `.corpus.json` and the next run
  carries on.

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

The same table holds for images and attachments.

Non-conflicting files are still applied in the same run. To resolve a conflict,
keep a copy of your version, run `corpus pull <slug> <path>` to take upstream's,
reapply your edit, and `corpus push <slug> <path>`. Or re-run with
`--overwrite`, which makes the directory match the corpus: it replaces every
conflicting or locally edited file and deletes edited files that were removed
upstream. Local edits are discarded, so commit or copy anything you want first.

### `push --all [dir] [--dry-run]`

Send the changes in a `pull --all` directory (default: the current directory)
back to Corpus. It compares the directory to its `.corpus.json` and sends:

- **modified files**: tracked files whose bytes differ from what was last
  pulled;
- **new files**: untracked `.md` files anywhere under `dir`, at their path
  relative to `dir` (missing folders are created);
- **deleted files**: tracked files that no longer exist locally;
- **renamed files**: a deleted tracked file plus a new file with the **same
  bytes** is one rename, so the document keeps its identity and history.

Images and attachments (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`,
`.svg`, `.pdf`, up to 10 MiB each) go the same way, with the key's `edit`
access: an untracked one is **uploaded**, a changed tracked one is **replaced**
(sent with the hash you last pulled, so it is refused if someone else replaced
it since), a deleted one is **removed**, and a renamed one is **moved**. Corpus
decides what a file is from its bytes, so a renamed program or a PNG called
`.pdf` is refused (listed as `failed`). A binary cannot be merged or reviewed
line by line, so it has **no proposal path**: a `suggest` key reports each as
needing edit access and sends nothing.

```sh
$ corpus push --all ./agent-docs --dry-run
dry run (edit access): nothing was sent. 3 change(s) planned in ./agent-docs
  update  runbooks/deploy.md  [deploy-runbook v4]
  create  runbooks/rollback.md
  move  style/old.md -> style/api.md  [api-style-guide]

$ corpus push --all ./agent-docs
applied 3, unchanged 5
~ runbooks/deploy.md
+ runbooks/rollback.md
> style/old.md -> style/api.md
```

How it behaves:

- **Plan first.** Everything is planned (listing, local reads) before the first
  write request. `--dry-run` prints that plan and sends nothing.
- **Conflicts never overwrite.** A tracked file whose upstream version (or
  path) moved since your last pull is a **conflict**: it is left untouched and
  reported, and the rest of the run continues. Exit `2`, as for `pull --all`.
- **Only markdown and images, only under `dir`.** Files that are neither `.md`
  nor an allowed image or attachment type are ignored and listed once. `.git/` and `.corpus.json` are always ignored. Inside a git
  work tree the file list comes from git (`git ls-files --cached --others
--exclude-standard`), so your `.gitignore`, `.git/info/exclude` and global
  ignore file are respected; outside one, every file under `dir` is a
  candidate. Nothing outside `dir` is ever read or written: symbolic links are
  never candidates, and a tracked file that has become a link to somewhere
  outside `dir` stops the run with an error (`pull --all` refuses it too).
  A file over the 1,000,000-byte document limit is reported as `failed`; the
  rest of the run continues.
- **Pull first.** There must be a `.corpus.json` (run `pull --all` once, even
  into an empty directory), so push can tell your edits from upstream's.
- **Unsafe paths stop the run** before anything is sent: an absolute path, `..`,
  a backslash or control character, a `.git` segment, or two paths that differ
  only by case.
- **The state file follows the server.** After a direct write the file records
  the new version, so an immediate `pull --all` is "up to date". After filing a
  proposal it does **not**: see [Grants](#grants).

| Exit | Meaning                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success, including "nothing to push" and proposals filed.                                                                                                                 |
| `1`  | Bad usage, missing config, a state file that is missing or invalid, an unsafe path, a key that may not push (`read`), or a write the server refused (listed as `failed`). |
| `2`  | Conflicts: some files were left untouched. Everything else was sent.                                                                                                      |
| `3`  | Transport or auth error: the server was unreachable or refused the key.                                                                                                   |

## Grants

The key's grant decides what `push` and `push --all` do with a change. The
owner sets it when minting the key and can change it any time (see
[API keys](./api-keys.md#grants)); existing keys can edit.

| Change you made                                      | `read`  | `suggest`                                                      | `edit`                                                               |
| ---------------------------------------------------- | ------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `list`, `pull`                                       | yes     | yes                                                            | yes                                                                  |
| Modify a file                                        | refused | **proposal** against the version you pulled                    | new version, written directly                                        |
| Add a new `.md` file                                 | refused | **proposal** for a new document at that path                   | document created at that path                                        |
| Delete a file                                        | refused | not sent, reported (a removal cannot be proposed)              | document **archived** (kept, not erased; the app has no restore yet) |
| Rename or move a file                                | refused | new path becomes a proposal; the old file is not removed       | document moved, history kept                                         |
| Add, change, delete or rename an image or attachment | refused | not sent, reported: needs `edit` (a binary cannot be proposed) | uploaded, replaced (`If-Match`), deleted or moved                    |

A `read` key stops before sending anything. A `suggest` key reports each
proposal's number and where to review it, and the server answers any attempt
to do more with a `403` whose body lists what the key may do instead. Proposals
carry the key's owner as author and arrive through the CLI channel, so reviewers
see them the way they see any agent's suggestion: hunk by hunk.

A rename together with an edit looks like a different file, so it is an archive
plus a new document (history stays with the archived one). Rename in its own
commit to keep history.

### Proposals are not synced

Filing a proposal changes nothing in Corpus, so `push --all` does **not** mark
the file as synced. The file keeps reading as a local edit, and the state file
remembers only _that_ it was proposed (a `proposals` list), so a CI job that
runs on every merge does not file the same proposal twice. Then:

- **Pull while the proposal is open:** the file is `kept` (local edit, upstream
  unchanged), not a conflict.
- **A person applies it** (all hunks): `pull --all` finds your bytes equal to
  the new upstream version and just updates the state file. Nothing is
  rewritten and there is no conflict.
- **A person applies part of it:** your file and upstream now differ and both
  changed, so `pull --all` reports a conflict, as it would for any edit made on
  both sides.
- **A person rejects it:** nothing changes. Your local edit stays in the file
  (and is still reported as `kept`). Run `corpus pull --all --overwrite` to
  take upstream's version, or revert the file in git. To propose again, change
  the file: an unchanged file is not re-proposed.

### The round trip

```text
pull --all   ->  edit in git (engineers, agents)   ->  push --all
     ^                                                      |
     |                                       edit key: applied now
     |                                    suggest key: review in Corpus
     +------------------  pull --all  <---------------------+
```

1. `corpus pull --all docs` brings the corpus into the repository.
2. People and agents edit the files; changes land on the main branch.
3. `corpus push --all docs` sends them back: applied (`edit`) or filed as
   proposals (`suggest`).
4. With `suggest`, a person reviews and applies them in Corpus.
5. The next `corpus pull --all docs` brings the result back; files you edited
   that were applied are already up to date.

Not supported: files other than markdown, images and PDFs; mirroring git
history into Corpus (or Corpus writing to git); merging two sides' edits to the
same file (that is a conflict you resolve by hand); proposing a removal, a move,
or any change to an image.

## The sync-state file

`pull --all` and `push --all` record what they synced in a single dotfile at the root of the
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
  ],
  "assets": [{ "path": "runbooks/arch.png", "slug": "…", "sha256": "…", "size": 48213 }],
  "proposals": [{ "path": "style/api.md", "baseVersion": 2, "sha256": "…", "proposalId": 31 }]
}
```

`assets` lists the tracked images and attachments (path, stable `slug`, `sha256`
and `size` of the bytes) and appears only when there are some. The format is
still `version: 1`: a CLI that predates images reads the same file and ignores
`assets`, and this CLI reads a file written without them. The
[Git mirror](./git-mirror.md)'s `.corpus.json` is byte-identical to the one
`pull --all` writes for the same corpus.

`proposals` appears only while `push --all` has filed proposals that are not yet
applied; entries drop out on their own once the file is tracked at a newer
version.

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
key is bound to, at its top level by default, so it shows up in `list` and is
readable immediately. Name a corpus-relative path with `--path` to put it in a
folder (missing folders are created):

```sh
corpus push onboarding ./onboarding.md --path people/new-hires/onboarding.md
```

With a `suggest` key the same push files a proposal for a new document.

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

What a key may do within its corpus is its [grant](#grants). **Minting** keys
and **changing a key's grant** are owner-only. Revoke a key the moment it might
be exposed — see [API keys](./api-keys.md).

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

This only copies the corpus's current files into the repository. To send
edits made in the repository back, see [`push --all`](#push---all-dir---dry-run)
and the [CI recipe](./recipes.md#round-trip-a-git-repository-through-ci). Corpus
does not mirror or write to git itself.

## REST API

The CLI is a thin client over these endpoints. Each takes the API key as a
bearer token and is scoped to the key's corpus:

| Method & path                               | Needs   | Does                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/docs`                          | read    | List the corpus's documents (`slug`, `title`, `docVersion`, `path`) plus the `corpus` identity and the key's `grant`.                                                                                                                                                  |
| `GET /api/v1/docs/:slug`                    | read    | Fetch one document's `markdown` + metadata. `404` if it is not in the corpus.                                                                                                                                                                                          |
| `PUT /api/v1/docs/:slug`                    | suggest | `{ markdown, clientVersion, title?, path? }`. `edit`: write a new version (version 0 creates; `path` places a NEW document). `suggest`: file a proposal against `clientVersion` (version 0: a new-document proposal); answers `202` with `proposalId` and `reviewUrl`. |
| `POST /api/v1/docs`                         | suggest | `{ markdown, path, title? }`: create at a corpus-relative path with a server-derived slug (`201`, `edit`) or propose it (`202`, `suggest`).                                                                                                                            |
| `DELETE /api/v1/docs/:slug?clientVersion=N` | edit    | Archive the document; `409` if it moved past `N`.                                                                                                                                                                                                                      |
| `POST /api/v1/docs/:slug/move`              | edit    | `{ path }`: move within the corpus (folders created), keeping history; `409` if the name is taken.                                                                                                                                                                     |
| `GET /api/v1/files`                         | read    | List the corpus's images and attachments (`slug`, `path`, `sha256`, `size`, `contentType`). `404` (`files_not_enabled`) when the server has no file storage.                                                                                                           |
| `GET /api/v1/files/:slug`                   | read    | The file's bytes, checked against their hash before they are sent. `404` if it is not in the corpus.                                                                                                                                                                   |
| `PUT /api/v1/files?path=P`                  | edit    | Raw bytes in. With `If-Match: "<sha256>"`, replace the file at `P` if it is still that (`412` with `currentSha256` if not, `null` when it is gone). Without it, create (`201`) where `P` is free; the same bytes again are `200`, different bytes `412`.               |
| `DELETE /api/v1/files/:slug`                | edit    | Delete the file, optionally with `If-Match` (`412` if it changed).                                                                                                                                                                                                     |
| `POST /api/v1/files/:slug/move`             | edit    | `{ path }`: move or rename within the corpus, keeping the slug; `409` if the name is taken, `422` if the new name would change the file's type.                                                                                                                        |

```sh
curl -H "Authorization: Bearer $CORPUS_API_KEY" \
  "$CORPUS_URL/api/v1/docs/api-style-guide"
```

File writes use the server's upload rules: the type comes from the bytes
(`415` for an unsupported one, `422` for an extension that does not match or an
unsafe SVG), at most 10 MiB (`413`), and the name in `P` must already be one the
server would keep (letters, digits, `.`, `_`, `-`, a lowercase extension).
There is no proposal path for a binary, so a `suggest` key's file write is a
`403` saying it needs `edit` access.

A write with too low a grant returns `403` with `{ error, code: "grant_too_low",
grant, needed, allowed }`, where `allowed` lists what the key may do instead. A
`PUT` whose `clientVersion` is behind the server returns `409` with the
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

(`pull --all` and `push --all` add `remove`, and `readBytes` / `writeBytes` for
images.)

The published `corpus` binary is the Node shell that wires `node:fs` + `node:process`
to that core. To run the CLI elsewhere — Deno, Bun, a Cloudflare Worker, or
a WASM host — supply your own `fetch` and `Files` adapter and call the same
exported `list`/`pull`/`push`. (The test suite does exactly this: the
worker's `fetch` plus an in-memory file map.)
