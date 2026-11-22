---
title: Clone with Git
description: A read-only Git mirror of each corpus on Cloudflare Artifacts — clone it into an agent sandbox with a short-lived token, no browser and no CLI session needed.
sidebar:
  order: 13
---

Some agents work best with files: they `grep`, run scripts, and edit in a
sandbox. If your Corpus server has the Git mirror turned on, every corpus
served to agents also exists as a **read-only Git repository**, and any API
key bound to that corpus can clone it.

Corpus stays the source of truth. The repository is derived from it and can be
thrown away and rebuilt at any time; you cannot push to it.

## What is in the repository

The tree is exactly what `corpus pull --all` writes: every document at its
corpus-relative path, byte for byte, every [image and attachment](./files.md) at
its path next to them, plus one `.corpus.json` at the root. A clone and a CLI
checkout are interchangeable. `.corpus.json` keeps `version: 1` and lists the
files in an optional `assets` array (path, slug, sha-256, size), so a CLI from
before images reads it too.

Every change in Corpus becomes one commit, authored by the person who made it
(under a non-identifying `…@users.noreply.corpus.invalid` address; the
committer is always `Corpus`). Renaming a document, archiving it, or moving it
out of the corpus is an ordinary commit that deletes the file, and so is
deleting an image. **Drafts is never mirrored.** A document or file whose path
cannot be a file in a checkout (a `.git` segment, for example) is left out, and
so is a file over 10 MiB.

Images are binary, so each one is committed as stored: Corpus does not spend CPU
compressing a PNG or JPEG a second time. Their bytes are read from file storage
one at a time, and a large change is pushed as **several commits** of about
16 MiB each (documents first, then images in path order). Each commit leaves a
complete, consistent checkout and an accurate `.corpus.json`, so a clone taken
between two of them is valid, and a failure part-way simply continues from the
last commit on the next attempt. A mirror whose corpus has images needs the
`FILES` binding (see [Images and files](./files.md#turning-it-on)); without it
the mirror reports an error rather than leaving the images out silently.

Mirroring is asynchronous. Saving a document never waits on it and never fails
because of it: the change is recorded in the same transaction, and a background
alarm pushes the difference, retrying with backoff if Artifacts is unreachable.
The "Clone with Git" section on a corpus's **Connect** page shows when the
mirror last synced, or why it has not.

## Clone it

With the [CLI](./cli.md) configured for the key's corpus:

```sh
corpus git clone            # prints a ready-to-run git clone, token valid ~1 hour
corpus git clone --helper   # tokens stay out of the command; git pull keeps working
```

The first form prints a command like

```sh
git -c http.extraHeader='Authorization: Bearer <token>' clone '<remote>' 'handbook' \
  && git -C 'handbook' config credential.helper '!corpus git credential'
```

so it needs nothing but `git` where it runs — paste it into an agent sandbox.
The token is **read-only** and scoped to this one repository; Corpus never hands
out a write token. The second form uses a git credential helper: `corpus git
credential` mints a fresh token whenever git asks, so `git pull` does not stop
when the first one expires.

Behind both is one endpoint, authenticated by the API key and scoped to the
key's corpus like the rest of the REST API:

```sh
curl -X POST -H "Authorization: Bearer $CORPUS_API_KEY" \
  https://corpus.example.com/api/v1/git/token
# { "remote": "…", "corpus": "handbook", "branch": "main",
#   "token": "…", "expiresAt": "…", "current": true }
```

It answers `404` when the server has no mirror and `409` while the first push
has not landed yet.

## Rebuild the mirror

Owners can **Rebuild mirror** from the Connect page. It deletes the repository
and recreates it from the corpus as it is now, in one commit. This is the only
way history is purged, and clones made before it will not fast-forward — clone
again. The mirror also rebuilds itself if its repository goes missing or its
head is not a commit Corpus pushed.

## Limits

A single push carries at most about 48 MiB and 40,000 objects (Artifacts allows
64 MiB and 50,000). Images are split across commits, so a corpus of images is
not bound by that; the documents and the files of any one commit are. A file
larger than 10 MiB is not mirrored. A corpus whose documents alone exceed the
single-push limit cannot be mirrored and the status says so. Artifacts bills each clone, fetch and push as an operation.

## Turning it on (self-hosters)

The mirror is **optional**: with no Artifacts binding the feature is off — no
records are kept, the endpoint answers "not enabled", and the Connect page hides
the section. To enable it:

1. Use a Cloudflare account with [Artifacts](https://developers.cloudflare.com/artifacts/)
   available. You do not create the namespace by hand — Artifacts creates it
   when the first repository is created.
2. Add the binding to the **top level** of `wrangler.jsonc`, choosing your own
   namespace name (2–63 characters, a letter or digit first):

   ```jsonc
   "artifacts": [{ "binding": "ARTIFACTS", "namespace": "corpus" }],
   ```

3. `pnpm deploy`. There is no secret and no environment variable to set.

Existing corpora start mirroring the first time someone opens their Connect
page (or on their next change). The binding is the only switch; removing it
turns the mirror off again.

For development, the test suite runs the mirror against the local Artifacts
simulator (Git 2.32+ on `PATH`) through the `mirror` wrangler environment; see
`wrangler.jsonc`.
