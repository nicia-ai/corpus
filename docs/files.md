---
title: Images and files
description: Paste, drop or pick an image while you write — it is stored next to the page and linked with a plain relative path. What is allowed, the limits, and how to turn storage on.
sidebar:
  order: 14
---

A page can show images. Paste a screenshot, drag a picture into the editor, or
choose **Insert image** in the editing controls: Corpus stores the file next to
the page and writes an ordinary markdown link for it. Nothing else about the
page changes — it is still plain markdown, byte for byte.

File storage is **optional**. If your Corpus server has none configured, the
editor simply has no upload controls and pasting an image does what your
browser does by default. [Turning it on](#turning-it-on) takes one bucket and
one line of configuration.

## Adding an image

- **Paste** an image from the clipboard (a screenshot, or a copied image).
- **Drag** one or more files from your computer onto the place in the page
  where they should go.
- Use **Insert image** in the editing controls to choose files.

While a file uploads, an **Uploading…** marker shows where the link will land.
When the upload succeeds the marker becomes the link, and the image appears. If
it fails, nothing is inserted and the message above the page says why (too
large, not a supported type, and so on).

The link is relative to the page:

```markdown
![architecture](./architecture.png)
```

The file lives in the **same folder as the page**, and its name is part of
that folder's names: a page, a folder and a file cannot share a name. A second,
different file with a name that is taken becomes `name-2.png`; the same image
added twice is one file. A pasted screenshot has no name of its own, so it is
called `pasted-` plus a short code taken from the image.

## What you can add

| Type                       | Shown as                               |
| -------------------------- | -------------------------------------- |
| PNG, JPEG, GIF, WebP, AVIF | an image in the page                   |
| SVG                        | an image in the page                   |
| PDF                        | a link; clicking it downloads the file |

Corpus decides what a file is from its **contents**, not its name or the type
your browser reports, so a renamed program is refused. An SVG is refused if it
contains a script, an event handler, embedded foreign content, or a reference
to anything outside the file; export it again from your drawing tool as plain
SVG.

Limits: **10 MiB per file** and **1 GiB per project**.

## Moving things

Images belong to a folder, not to a page. Renaming a folder, or moving it to
another place, keeps every page's images working, because the page and its
images move together. Moving a **page by itself** away from its images breaks
its links: Corpus never rewrites your markdown, so the page shows a plain
**Missing image: name** placeholder where each image was. Move the page back,
or add the image again.

Deleting a folder or a corpus removes its files with it. Files do not keep a
version history: the bytes of an image never change, and replacing a picture
means adding a new one.

## Who can add files

Anyone who can edit the page. Credentials that can only suggest edits (share
links set to suggest, and agent API keys with the suggest grant) cannot add,
replace, delete or move files: a binary cannot be merged or reviewed line by
line, so there is nothing to propose.

## In a repository: Git and the CLI

Images and attachments travel with the pages that link them.

- The [Git mirror](./git-mirror.md) of a corpus holds each file at its
  corpus-relative path, byte for byte, so a clone has the pictures next to the
  markdown that shows them.
- [`corpus pull --all`](./cli.md#pull---all-dir---overwrite) writes the same
  files, verifies each against its hash, and never overwrites one you changed
  locally. [`corpus push --all`](./cli.md#push---all-dir---dry-run) sends new,
  changed, deleted and renamed ones back with an `edit` key; a change is refused,
  not overwritten, if someone else replaced the file since you pulled it.
  Update the CLI to 0.2.0 or newer to carry images; an older one ignores them.
- The REST API behind the CLI is under `/api/v1/files` (see the
  [CLI guide](./cli.md#rest-api)).

Both write the same `.corpus.json`, which lists the files in an `assets` array
beside the documents.

## Agents (MCP)

A connected agent can look at the images in its corpus. `list_files` lists the
corpus's files (path, size, type), and `read_file` returns one: PNG, JPEG, GIF
and WebP come back as an image the agent can see. SVG and PDF files return
only their name, size and type. Files over 5 MiB are refused with a message
that says how large they are.

`read_file` takes a corpus `path`. To use a link exactly as it is written in a
page, pass it as `path` together with that page as `document`:
`./diagram.png` then resolves next to the page, the way the editor resolves it.
A path that leaves the corpus (`../` past its root, another corpus's files) is
refused. Without file storage turned on, `read_file` answers that files are not
enabled. Agents cannot add files.

## What is not included yet

- A **project export** (Settings → Export) does not include files. It says how
  many images and attachments it left out; relative links to them stay as they
  are and show the missing-image placeholder after an import.

## Images on a shared page

A person who opens a share link sees the page's images. The page the link
opens shows each image from a link-specific address (`/s/<token>/f/<hash>`),
which carries no file name or folder. The link can fetch only the images the
page's **current** version refers to: an image you take out of the page stops
loading for the link, and a file in the same project that the page does not
use is never reachable through it. Images are cached for five minutes, so
revoking or expiring a link, or removing an image, takes effect within that
time. A link to a PDF or other attachment on the page downloads it.

The share-link page is a plain page with a text box for edits, so there is no
image upload there. A link with Edit or Suggest access can change the
markdown but cannot add files. An agent that reads the link as markdown
(`Accept: text/markdown`) still gets the page's text exactly as written, with
the relative image paths and no image access.

## Turning it on

Files are stored in a Cloudflare R2 bucket bound to the Worker as `FILES`. The
bucket stays private; every file is served through Corpus, behind the same
sign-in and project membership as everything else, and a project's files are
kept under its own prefix.

1. Create a bucket:

   ```sh
   wrangler r2 bucket create corpus-files
   ```

2. Add the binding to the **top level** of `wrangler.jsonc`, with your
   bucket's name:

   ```jsonc
   "r2_buckets": [{ "binding": "FILES", "bucket_name": "corpus-files" }],
   ```

3. `pnpm deploy`. There is no secret and no environment variable to set.

The binding is the only switch; removing it turns uploads off again (files
already stored stay in the bucket).

An upload writes the file to the bucket first and records it in the project
second, so a failure in between can leave bytes nothing refers to. A sweep that
runs with the hourly retention job removes those leftovers after 24 hours, and
removes the files of a deleted project. The optional `fileDays` retention
setting controls how long a deleted file's record is kept before it is removed
for good; unset means forever.

For development, the test suite runs the uploads against a local R2 bucket
through the `files` wrangler environment; see `wrangler.jsonc`.
