---
title: Recipes & best practices
description: Patterns that make Corpus pay off — designing corpora agents actually follow, keeping docs agent-readable, and wiring it into your workflow.
sidebar:
  order: 11
---

Corpus is simple on purpose. The leverage is in _how_ you structure
your corpora. These are patterns that work in practice.

## Design corpora around an audience, not a topic

A corpus is "what this kind of agent should know," not "everything
about X." Name them for the reader:

- `backend-agent` — conventions, error model, testing rules.
- `release-reviewer` — the checklist a PR-review agent applies.
- `support-bot` — product facts and tone for a customer-facing agent.

Each document lives in exactly one corpus, so don't copy a document
per audience. Shared knowledge (say `error-handling`) goes in its own
corpus, and each agent connects to every corpus it needs. A
`backend-agent` connected to `company` and `backend-agent` reads both.
See [Corpora](./corpora.md#sharing-knowledge-between-corpora).

## Keep each corpus focused

A corpus is a drive for one kind of reader. When one grows past what
that reader needs, split it by task (`backend-agent-writing` vs
`backend-agent-reviewing`), and move documents between corpora from the
Corpus page. Moving takes effect on the agent's next request, and the
history of each document moves with it.

Name documents so the list reads well. The agent sees every path in
alphabetical order, so a folder per topic (`policies/refunds.md`,
`policies/returns.md`) makes the list easy to scan.

## Write documents for an agent reader

- One clear `# H1` per document; explicit imperative rules ("Always
  validate input with Zod at the boundary") beat prose.
- State the rule _and_ the rationale — agents follow rules they
  understand better than bare edicts.
- Avoid implicit context ("as discussed last sprint"). The agent has
  only what's in the corpus.
- Link related documents by relative path; the editor flags broken links.
  An agent that follows a link reads the target with `read_document`.

## Use frontmatter as a control surface

Put `status`, `owner`, `audience` in [frontmatter](./documents.md).
It never changes the file the agent reads, but an agent can call
`read_document_meta` and skip or downweight a doc marked
`status: draft`. Good for staging changes before they're authoritative.

## Wire it into the agent durably

Don't rely on remembering to say "read the corpus." Put it in the
agent's standing instructions:

- **Claude Code** — add a line to `CLAUDE.md`: _"At the start of any
  task, work from the corpus you're connected to: list its documents,
  and read `docs/error-handling.md` when the task touches errors."_
- **Cursor / others** — the equivalent rules file.

You can name a specific document by its corpus path — _"read
`docs/error-handling.md` from Corpus"_ — and the agent will pull just
that one within the Connection's bound Corpus. Naming the documents that
matter in standing instructions keeps prompts precise and tells the agent
what to read first.

Now every session starts from your canonical corpus, and updating it in
Corpus updates every agent on the next read — no redeploy, no re-paste.

## Edit fearlessly

Nothing is lost: every save is a new version, concurrent edits get a
[resolution screen](./versioning-and-history.md), and you can verify
the chain. Non-engineers should edit directly — that's the workflow
Corpus exists to enable. Treat the [changes feed](./versioning-and-history.md)
as the "what moved" check before a consequential agent run.

## Co-write one page with several agents

When two people each run their own agent against the same page — an event
plan, a launch checklist — make one [share link](./share-a-page.md) per
person and name it for them ("Dana's Claude Code"). Tell each agent which
section is theirs and have it use the section write
(`PUT /s/<token>/section?heading=…`) rather than rewriting the whole page:
a section write lands even when someone else edited a different section
since the agent last read. The prompt already tells the agent to save the
link in its project instructions, so a page that changes over days (an RSVP
list, a status table) stays editable from later sessions. Set the link to
no expiry for a long-running page, and switch it to Suggest when you want to
review changes before publishing.

## Separate stable from fast-moving

Keep rarely-changing knowledge (`engineering-principles`) in a corpus
that every relevant agent connects to. Volatile specifics
(`q3-migration-plan`) belong in the corpus of the team doing that work.
When the work is done, move the document into Drafts, or into an archive
corpus, without deleting its history.

## Round trip a git repository through CI

Teams keep the markdown their agents read in a git repository that engineers
and their agents also edit. Two CI jobs keep it and Corpus in step, using one
directory (`agent-docs` below) and one key per corpus. Use a `suggest` key if
changes made in git should be reviewed in Corpus before they land (recommended),
or an `edit` key to apply them directly. See [Grants](./cli.md#grants).

**On every merge to the main branch**, send the repository's changes to Corpus:

```sh
npm install --global @nicia-ai/corpus-cli
# CORPUS_URL and CORPUS_API_KEY come from the CI system's secret store.
corpus push --all agent-docs
```

**On a schedule** (say every 15 minutes), bring Corpus's changes into the
repository and commit them:

```sh
corpus pull --all agent-docs
git add agent-docs
if ! git diff --cached --quiet; then
  git commit -m "Sync from Corpus"
  git push
fi
```

In GitHub Actions (checkout and Node setup omitted):

```yaml
on:
  push:
    branches: [main]
    paths: ["agent-docs/**"]
  schedule:
    - cron: "*/15 * * * *"
jobs:
  corpus:
    runs-on: ubuntu-latest
    permissions: { contents: write }
    env:
      CORPUS_URL: ${{ secrets.CORPUS_URL }}
      CORPUS_API_KEY: ${{ secrets.CORPUS_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install --global @nicia-ai/corpus-cli
      - if: github.event_name == 'push'
        run: corpus push --all agent-docs
      - if: github.event_name == 'schedule'
        run: |
          corpus pull --all agent-docs
          git add agent-docs
          git diff --cached --quiet || {
            git -c user.name=corpus-sync -c user.email=corpus-sync@users.noreply.github.com commit -m "Sync from Corpus"
            git push
          }
```

How it behaves:

- Exit `2` means a conflict: someone changed the same file on both sides. The
  job fails so a person can resolve it; everything else was applied.
- With a `suggest` key, the push step reports each proposal and a link to
  review it; a person applies it in Corpus, and the next scheduled pull brings
  it back (the file you edited is already identical, so it just becomes synced).
  A pushed change is not filed twice.
- A rejected proposal leaves your edit in the repository. Revert it in git, or
  run `corpus pull --all --overwrite agent-docs` once to take Corpus's version.
- With a `suggest` key, deleting a file in git cannot be proposed, and the next
  scheduled pull will restore it. Archive documents in Corpus, or use an `edit`
  key for jobs that must propagate deletions.

Not supported: files other than markdown, images and PDFs (ignored and listed); Corpus
writing to git (it never does); merging two sides' edits to one file; renaming
and editing a file in one commit while keeping history (that becomes an archive
plus a new document); more than one corpus per directory.
