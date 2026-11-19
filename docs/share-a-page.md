---
title: Share a page with agents
description: Give one document to a coworker's terminal agent with a share link — the three grants, the copyable prompt, section-scoped writes, conflicts, revoking, and a worked two-person example.
sidebar:
  order: 9
---

A **share link** gives one document to an agent that is not connected to
your project. You make a link, paste a prompt into Claude Code or Codex,
and that agent reads — and, if you allow it, writes — that single page over
plain HTTP. Nothing else in the project is reachable from the link.

Use it when several people, each with their own agent, need to work on one
page together: an event plan, a launch checklist, a meeting doc. It is
separate from [Connect your agent](./connect-your-agent.md), which binds an
agent to a whole corpus over MCP.

## What a share link is

A link is a URL of the form `https://your-corpus-host/s/<token>`. The token
is the credential — anyone holding it has exactly the access you granted,
so treat it like a password. Each link has:

- one **document** it opens (never a folder or a corpus);
- one **grant** (below);
- a **name** you choose, which labels every change made through it;
- an **expiry**, which you choose (7 days, 30 days, 90 days, or no expiry)
  and can extend later.

Only an organization owner can create, rename, extend, or revoke links.

## The three grants

Each grant includes the ones before it.

| Grant       | The agent can                                                                        |
| ----------- | ------------------------------------------------------------------------------------ |
| **View**    | Read the page.                                                                       |
| **Suggest** | Read it and propose an edit. You review the proposal and accept or reject it.        |
| **Edit**    | Read it and write it directly, as many times as needed. Each write is a new version. |

Direct editing is only available while the page is **not served by a
corpus**. The moment a page is attached to a corpus, an Edit link behaves
as Suggest: writes are refused with a `403` that tells the agent to propose
instead, so nothing reaches an agent consumer without review. See
[Corpora](./corpora.md).

## Create a link

1. Open the document and choose **Share**.
2. Type a **Link name**. Name the person or agent who will use the link,
   for example "Dana's Claude Code".
3. Pick the access level and how long the link lasts.
4. Choose **Create link**, then **Copy prompt**.

To start a page that an agent will fill in, use **New intake** on the
Documents page: it creates an empty page with an Edit link and copies the
prompt in one step.

## One link per collaborator

Make a separate link for each person or agent. The link name is recorded
against every change made through it, so version history, the review rail,
and the change feed read "Dana's Claude Code" and "Sam's Codex" instead of
an anonymous shared agent. It also lets you revoke or downgrade one
collaborator without touching the others. Revoked and expired links keep
their name on past changes.

## The prompt

**Copy prompt** gives you text to paste into the agent. For an Edit link it
looks like this (the URL is yours):

```text
You are helping me work with a shared Corpus page.

Fetch the current document:
  GET https://your-corpus-host/s/<token>
  Accept: text/markdown

The response body is markdown. X-Doc-Version is the version you must send back.

You may edit this page directly. To add or update one part, replace only that
section. The heading text goes in the query (URL-encoded); the body is the
section's content without its heading line. A missing section is added at the
end; a section's subsections belong to it.
  PUT https://your-corpus-host/s/<token>/section?heading=Participants
  Content-Type: text/markdown
  X-Doc-Version: {version from GET}
  body: new content of that section

Use a whole-page PUT only to rewrite the entire page:
  PUT https://your-corpus-host/s/<token>
  Content-Type: text/markdown
  X-Doc-Version: {version from GET}
  body: full markdown

On 409, someone else changed the page (or that section): GET it again, keep
their changes, and retry. If a write ends with a 403, POST the full proposed
markdown to https://your-corpus-host/s/<token>/suggest instead (same headers).

This page keeps changing. Save this link and these instructions in your
project instructions file (CLAUDE.md, AGENTS.md or similar) so later sessions
can keep working on it:
  https://your-corpus-host/s/<token>
GET it again at the start of every session before you write.

Start by fetching the page. Then: Start from the fetched page.
```

View and Suggest links get the same preamble, the `/suggest` instructions
(Suggest only), and the same "save this link" note. Add your own request
after the prompt: "Add the engineering guidelines for participants."

The "save this link" paragraph is what makes the page ongoing. The agent
writes the link into its project instructions file, so a session next week
starts from the same page without you pasting anything again.

## The HTTP endpoints

All endpoints live under `/s/<token>`. Bodies are markdown
(`Content-Type: text/markdown`). `X-Doc-Version` is the version number
returned by the last `GET`.

| Request                                 | Grant   | What it does                                                                                                                                       |
| --------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /s/<token>`                        | any     | Returns the page as markdown (`Accept: text/markdown`) with `X-Doc-Version`. A browser (`Accept: text/html`) gets a readable page with the prompt. |
| `PUT /s/<token>`                        | edit    | Replaces the whole page. Returns `{"ok":true,"docVersion":N}`.                                                                                     |
| `PUT /s/<token>/section?heading=<text>` | edit    | Replaces one section. Returns `{"ok":true,"docVersion":N,"created":bool}`.                                                                         |
| `POST /s/<token>/suggest`               | suggest | Proposes a full replacement for review. Returns `201` with `{"ok":true,"suggestionId":"…"}`.                                                       |

### Section write

`PUT /s/<token>/section?heading=Participants` replaces the content of the
section whose heading reads "Participants", and nothing else.

- **The body is the section's content, without its heading line.** The
  heading itself is kept exactly as it was written.
- **A section runs from its heading to the next heading of the same or a
  shallower level.** Deeper subsections belong to their parent, so replacing
  `## Guidelines` also replaces any `### …` headings under it. Everything
  outside the section — other sections, frontmatter, spacing — is preserved
  byte for byte.
- **A missing section is created at the end of the page**, as a level-2
  heading unless you pass `&level=N`. The response has `"created":true` —
  check it: a misspelled heading creates a new section rather than editing
  the one you meant.
- **Headings match on their text**, with inline formatting removed and
  whitespace collapsed, case-sensitively. `?heading=Participants` and
  `?heading=%23%23%20Participants` (`## Participants`) both work; a `#`
  prefix also sets the level. Headings inside code blocks never count.
- **Duplicate headings are refused, not guessed at.** If the text matches
  more than one section, you get `422` listing each match by level and line.
  Add `&level=N` to pick one depth. If two headings share text and depth,
  rename one with a whole-page `PUT` first.
- **The body may not contain a heading at the section's level or shallower**
  (that would split it into two sections), and may not leave a code fence
  open. Either gets `422` with the reason. To add a sibling section, make a
  separate request for it.
- An empty body empties the section and keeps its heading.

Each section write is one new version, saved in one transaction.

### Conflicts

`X-Doc-Version` is optimistic concurrency: it says which version the agent
last read.

- For a **whole-page** `PUT`, the version must equal the current one, or the
  write is refused with `409` and nothing changes.
- For a **section** write, a version that is behind is still accepted when the
  section being written is **identical** in the agent's version and in the
  current one — someone else edited a different section. The change is applied
  to the current page, so nobody's edit is lost. If that section changed, if the
  agent's version is no longer retained, or if the version is ahead of the page,
  the write is refused with `409`.

A `409` body is `{"ok":false,"conflict":true,"currentVersion":N}`. The agent
should `GET` the page again, look at what changed, redo its edit against the
new text, and send it with the new `X-Doc-Version`. Never retry the same
body blindly.

Other responses an agent may see:

| Status | Meaning                                                                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | Missing `X-Doc-Version`, missing or invalid `heading`/`level`, or invalid frontmatter.                                                                                                      |
| `403`  | The link does not allow the write: View link, Edit link switched to Suggest, or the page is now served by a corpus. The message says to use `/suggest`. A plan quota can also return `403`. |
| `404`  | Revoked, expired, or unknown link — or the page is gone.                                                                                                                                    |
| `413`  | The body, or the page after the write, is over the document size limit.                                                                                                                     |
| `422`  | Section write only: ambiguous heading, or a body that would change the page's structure.                                                                                                    |
| `429`  | The link has used all of its writes.                                                                                                                                                        |

## Revoke, or switch to suggest-only

In **Share**, each link has its own controls:

- **Access** switches a link between View, Suggest, and Edit. Switching an Edit
  link to Suggest takes effect on the very next write: the agent is told to
  propose instead, and its proposals arrive for your review. Use this when a
  page is ready to review before it is published.
- **Keep open** removes the expiry on a link that is still live. A link that has
  already expired or been revoked cannot be revived; make a new one.
- **Revoke** kills one link immediately (`404` from then on). **Unshare** revokes
  every link on the page.

Archiving or deleting a page, or deleting the project, also revokes its links.

## Limits

- **Terminal agents only.** The agent must be able to make HTTP requests with
  custom headers and a request body — Claude Code, Codex, or a script. Browser-hosted
  chat agents (a chat tab that can only fetch pages) can read a link but cannot
  write through it. In a browser, an Edit link opens a page where a person can edit
  the full markdown by hand.
- **One page per link.** A link never opens other documents.
- **Document size.** 1,000,000 bytes (1 MB) per document and per request body.
- **Writes per link.** Each link allows 1,000 writes over its lifetime, counting
  `PUT` and `POST /suggest`. A write that is refused (for example a `409`) does
  not count. When a link runs out, writes return `429`; make another link.
- **Expiry.** New links default to 30 days. A link is dead after it expires; an
  owner can extend it while it is live.
- **Served pages are suggest-only.** See [the three grants](#the-three-grants).

## Worked example: two coworkers, one hackathon page

Priya and Sam run a hackathon. Priya owns the Corpus organization.

**1. Priya creates and shares the page.** On the Documents page she chooses
**New intake**, titles it "Spring Hackathon", and Corpus copies a prompt. She
opens the page, chooses **Share**, and sees one Edit link named "Intake draft".
She renames it "Priya's Claude Code" and chooses **Create another link**: name
"Sam's Claude Code", access Edit, expires after 90 days. She copies the prompt
for Sam's link and sends it to him.

**2. Both put the link in their Claude Code sessions.** Each pastes their own
prompt into a session in their project. The prompt (shown above, with their own
link) tells the agent how to read the page, how to write one section, and to save
the link in `CLAUDE.md`.

**3. Priya has her agent add the guidelines.** She follows the prompt with:

> Add an "Engineering guidelines" section for participants: teams of up to
> four, a working demo by Sunday 4pm, use any stack, open-source your repo.

Her agent fetches the page (version 1, an empty page) and writes the section:

```text
PUT https://your-corpus-host/s/<priya-token>/section?heading=Engineering%20guidelines
X-Doc-Version: 1

- Teams of up to four.
- A working demo by Sunday 4pm.
- Any stack. Open-source your repo.
```

The page does not have that heading, so it is added at the end. The response is
`{"ok":true,"docVersion":2,"created":true}`.

**4. Sam has his agent add the details, at the same time.** Sam says:

> Add a "Location and schedule" section: Pier 9, Friday 6pm to Sunday 6pm,
> doors at 5:30. Then add an empty "Participants" section.

Sam's agent fetched version 1 before Priya's write. It sends:

```text
PUT https://your-corpus-host/s/<sam-token>/section?heading=Location%20and%20schedule
X-Doc-Version: 1
```

Version 1 is behind the page (now version 2), but "Location and schedule" is
absent in both, so the write is applied to the current page and returns
`{"ok":true,"docVersion":3,"created":true}`. Priya's section is untouched. Sam's
second request creates "Participants" the same way.

**5. Sam keeps the participant list current over several days.** The "save this
link" instruction put the link in Sam's `CLAUDE.md`. On Tuesday, Sam opens a new
session and says:

> Dana and Lee RSVP'd. Update the participant list.

His agent reads `CLAUDE.md`, `GET`s the page (version 9 by now, edited by others
since), and replaces only the section:

```text
PUT https://your-corpus-host/s/<sam-token>/section?heading=Participants
X-Doc-Version: 9

- Priya
- Sam
- Dana
- Lee
```

If Priya's agent edited "Participants" in the meantime, this returns `409`; Sam's
agent re-fetches, merges Priya's change into the list, and retries.

**6. Who did what.** The page's version history labels each version "Priya's
Claude Code" or "Sam's Claude Code". When the page is ready to publish, Priya
attaches it to a corpus. From then on both links propose instead of writing, and
she reviews each change before it reaches the agents that read the corpus.
