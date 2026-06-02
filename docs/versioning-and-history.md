---
title: Versioning & history
description: Every document edit is a new version, conflicts are resolved not lost, and the change feed shows what moved — how Corpus keeps your canonical collection trustworthy.
sidebar:
  order: 8
---

Your agents act on what's in Corpus, so Corpus treats history as
first-class: every edit is an append, conflicts are resolved (never
lost), and you can verify the chain is intact.

## The version ledger

Each time you save a document, Corpus appends a new version. Versions
are content-addressed and chained — each one records the content it was
based on. The document page shows the current version (`v5`); the
**Versions** view lists every version with who changed it, when, and a
summary of what changed.

Renaming a document's title is metadata and does **not** create a
version. Only body changes do.

## Conflict resolution

If you and a teammate edit the same document at the same time, the
second save doesn't clobber the first. Corpus detects that the document
moved underneath you and opens a resolution screen:

> **Someone else edited this.** The document changed while you were
> editing. Choose how to resolve — nothing is lost.

You see their version and yours side by side, plus a summary of what you
changed, and choose:

- **Keep mine (overwrite theirs)** — save your draft on top of their
  version.
- **Keep theirs (discard mine)** — take their version, drop your draft.
- **Edit on top of theirs** — load their version into the editor and
  keep working.

There is no lost write and no forced merge — you decide.

## The changes feed

**Recent changes** shows the latest document and collection activity —
creates, saves, attaches — with who and when. It's the quick answer to
_"did the canonical collection move, and who moved it?"_ before you point
an agent at it.

## Verifying the chain

Agents can call the `verify_history` tool to confirm a document's (or
the whole project's) version chain is internally consistent — every
content hash and parent link re-derives. Useful in a CI check before an
agent relies on a collection for something consequential.

## Retention

A project can set a retention policy (how long old document versions,
change events, and unreferenced content are kept). Defaults to keeping
everything. Retention never removes a document's current version or any
version still pinned by a collection, and never breaks `verify_history` —
pruned-but-safe gaps are treated as expected, not corruption.

## Getting your data out

**Settings → Export** in the web UI produces a complete, portable,
content-addressed JSON bundle of the project — every document, every
version, every collection, and the membership snapshots. Export is an
owner action, always available and never gated; bundle export is
deliberately not on the agent MCP surface (agents only ever read the
Collection their Connection binds them to). Your canonical collection is
yours; you can always take it with you.
