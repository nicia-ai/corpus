---
title: Documents
description: Writing and editing the markdown documents that make up your canonical collection — slugs, frontmatter, the version ledger, and conflict resolution.
sidebar:
  order: 3
---

A **document** is one markdown file. It is the atom of your canonical
collection: written once, versioned forever, shared across as many collections
as you like.

## Creating a document

**Documents → Document** (the **+** button). Enter a **Title** and the
**Markdown** body, then **Create**.

The title is turned into a stable **slug** — `API Style Guide` becomes
`api-style-guide`. The slug is the document's stable internal identity,
and it does not change when you rename the title later. Agents usually
refer to uploaded documents by their Corpus path, while slugs remain
available in MCP responses for stable low-level addressing. If a
document with that slug already exists you'll see _"A document with this
title already exists."_ — pick a different title.

## Editing

Open a document and click **Edit**. The editor has two tabs:

- **Write** — a markdown editor.
- **Preview** — the rendered result.

Click **Save** to commit, or **Cancel** to discard the draft. Each save
creates a new version (see [Versioning &
history](./versioning-and-history.md)).

Prefer your own editor, or editing from CI? The [CLI](./cli.md) pulls and
pushes the same documents from a terminal, with the same versioning.

### Broken-link warnings

While editing, Corpus checks markdown links that point at other
documents in this project. If a link points at a slug that doesn't
exist, the editor shows a count (e.g. _"2 links to a missing
document"_). It's a warning, not a block — you can still save. Fix it by
correcting the slug or creating the target document.

### Renaming the title

Use **Rename** on the document page to change the displayed title. This
is metadata only: it does **not** change the slug and does **not** create
a new content version. The Corpus path comes from the document's folder
and filename, not its title.

## Frontmatter

You can put a YAML frontmatter block at the top of any document:

```markdown
---
owner: platform-team
status: stable
audience: backend-agents
---

# Backend conventions

...
```

Frontmatter is a **read-time lens, never a mutation**. The canonical
file an agent reads is returned verbatim — frontmatter and all. Corpus
also exposes the parsed frontmatter separately (the `read_document_meta`
MCP tool) so an agent can branch on `status` or `audience` without
parsing it itself. The body and its version hash are never altered by
frontmatter.

If the YAML is malformed, the save is rejected with _"invalid YAML
frontmatter: …"_. Either fix the YAML or remove the block.

## Importing existing markdown

Have docs already written somewhere? Click **Upload** on the Documents
page (or drop files into the empty-state uploader). Drag a folder, pick
individual files, or drop a `.zip` — Corpus keeps the folder structure,
imports every Markdown/text file under it, and lands you on Documents
with a summary toast (`12 added · 3 updated · 1 failed`). Each imported
file becomes a canonical document; re-uploading an unchanged file is a
no-op, and an edited file appends a new version. The same slug-collision
rule applies within a folder.

## What an agent sees

When an agent reads a document (directly, or as part of a collection) it
gets the **exact markdown** you wrote, at the current version. Write for
the agent: clear headings, explicit rules, no implicit collection. See
[Recipes](./recipes.md) for patterns.

Documents are **read-only over MCP**. Agents consume them; only people
(in the web UI) change them. That asymmetry is deliberate — your
canonical collection can't be silently rewritten by an agent.
