---
title: Documents
description: Writing and editing the markdown documents that make up your canonical corpus — slugs, frontmatter, the version ledger, and conflict resolution.
sidebar:
  order: 3
---

A **document** is one markdown file. It is the atom of your canonical
corpus: written once, versioned forever, shared across as many corpora
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

Open a document and start writing. Markdown renders inline as you type;
clicking formatted text reveals its syntax. Use **Source** to show all
Markdown syntax. Switching views preserves your draft, selection, and undo
history.

The editing controls provide bold, italic, strikethrough, inline code, links,
and indentation. **Insert / change…** adds a heading, quote, list, code block,
or table, or converts selected lines to a different block type. Tables are
inserted as editable Markdown; visual row and column editing is not available.

Use **Cmd** on macOS or **Ctrl** elsewhere:

| Action                                          | Shortcut             |
| ----------------------------------------------- | -------------------- |
| Bold / italic / link                            | Cmd/Ctrl+B / I / K   |
| Inline code / strikethrough                     | Cmd/Ctrl+Shift+C / X |
| Indent / outdent                                | Cmd/Ctrl+] / [       |
| Nest / unnest list items; indent / outdent code | Tab / Shift+Tab      |
| Undo                                            | Cmd/Ctrl+Z           |

Enter continues lists, tasks, and quotes; Enter on an empty item exits it.
Tab moves a list item's nested children with it. Outside lists and code, Tab
moves keyboard focus. Press **Escape**, then **Tab**, to leave the editor
from a list or code block. **Keyboard shortcuts** below the controls shows
these bindings while you write.

The link action selects a destination placeholder after wrapping selected
text, or selects the label placeholder when no text is selected. Within an
existing inline link, it selects the destination for editing.

Click **Save** to commit, or **Discard** to discard the draft. Each save
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

When an agent reads a document (directly, or as part of a corpus) it
gets the **exact markdown** you wrote, at the current version. Write for
the agent: clear headings, explicit rules, no implicit context. See
[Recipes](./recipes.md) for patterns.

Documents are **read-only over MCP**: an agent can never write one
directly. It can file a proposal with `suggest_edit`, which a person
accepts or rejects, hunk by hunk, in the web UI. That asymmetry is
deliberate — your canonical documents can't be silently rewritten by an
agent.
