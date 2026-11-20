---
title: Corpora
description: Corpora are drives of markdown documents — each document belongs to exactly one corpus, agents connect to the corpora they need, and Drafts is the unpublished space.
sidebar:
  order: 4
---

A **corpus** is a self-contained drive: a tree of folders and markdown
documents that belongs together. Every document lives in exactly one
corpus, and nothing lives outside one. An agent connected to a corpus
sees that drive as a folder of markdown files and reads what its task
needs.

Corpora do not nest. A corpus cannot hold another corpus, and a document
cannot belong to two corpora.

## Creating a corpus

**Corpora → Corpus**. Give it a **Name** and an optional
**Description**, then **Create corpus**. The name is the corpus's slug
in the API and CLI.

Pick names by _who reads it_, not by topic — `backend-agent`,
`support-desk`, `company`. Because each document belongs to one corpus,
you don't copy content to serve different audiences. Put shared
knowledge in its own corpus and connect each agent to every corpus it
needs (see [Sharing knowledge between corpora](#sharing-knowledge-between-corpora)).

## Adding documents and folders

Documents start in **Drafts** (see below). To put a document into a
corpus, open it or select it in the list and choose **Move**, then pick
the corpus. Folders move the same way: **Move folder to…** moves the
folder and everything in it.

Any project member can move documents and folders between corpora. A
moved document keeps its history, comments, proposals and share links.

Paths are relative to the corpus root. A document at
`policies/refunds.md` inside the **Company** corpus is shown and read as
`policies/refunds.md`. The corpus's own root folder is internal and is
never part of a path.

Agents list a corpus's documents in alphabetical order by path. There is
no manual ordering, no always-included set, and no size budget: an agent
lists the corpus, then reads the documents its task needs.

## Drafts

Every project has one built-in corpus called **Drafts**. It is the
unpublished space. New pages and pages shared by link start there.

Drafts is not served. It cannot be connected to an agent or an API key,
and agents never see its contents. Moving a page out of Drafts into a
named corpus publishes it. Moving it back into Drafts unpublishes it.

Drafts cannot be deleted.

## Sharing knowledge between corpora

Knowledge that several audiences need is shared by connecting one agent
to several corpora, not by placing one document in two corpora. The
example project shows the pattern:

- **Company** — refund policy, product, brand voice.
- **Support desk** — the support playbook.

A support agent connects to both. It reads the company policy and the
playbook from the two corpora it is connected to, and each document is
edited in one place.

Links between corpora still work in the web app. When a link points at
a document in a different corpus, the editor warns that the document is
_in a different corpus — agents connected to this corpus can't read it_.

## Deleting a corpus

Only a project owner can delete a corpus. Deleting asks what should
happen to its pages:

- **Delete its pages too** (pre-selected). Pages are archived, not erased.
  Their history is kept, and their share links stop working.
- **Move its pages to Drafts.** Pages are kept and unpublished. Agents
  can no longer read them until you move them into a corpus.

Either way, agents and API keys connected to the corpus are removed.

## What the agent receives

A connected agent sees the corpus as a folder of markdown files. Its
tools are listed in [Connect your agent](./connect-your-agent.md#what-the-agent-can-do):

- `list_collections` describes the corpus the connection is bound to.
- `list_documents` lists every file, by corpus-relative path, in
  alphabetical order.
- `read_document` returns one document's markdown, verbatim, by path or
  slug.

Nothing is delivered automatically. The agent is not handed a README,
an index, or the whole corpus on connect. It lists, then reads.

A Connection is bound to exactly one corpus, so the agent does not pass
a corpus name. The credential cannot read documents outside that corpus.

Agents cannot write canonical content. They can only file a proposal
with `suggest_edit`, which a person reviews in the web app.

## Editing and moving take effect on the next call

Editing a document, moving it into or out of the bound corpus, and
moving folders take effect on the agent's next request. There is nothing
to publish or deploy.

## Upgrading from an earlier version

Projects created before this model are migrated automatically the first
time they are opened:

- Each existing corpus keeps its documents, under a root folder for that
  corpus. Each document keeps its path inside it.
- Documents that were in no corpus move to Drafts.
- A document that was in two or more corpora stays in the earliest-created
  one. The activity log records the move.
