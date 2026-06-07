---
title: API keys
description: Long-lived bearer tokens for agents and scripts that can't run the OAuth flow — scoped to one Connection (Project + Collection), shown once.
sidebar:
  order: 6
---

An API key authenticates an MCP client **as you, against a single
Connection** — a (Project, Collection) pair that decides exactly which
collection the agent will see. Use one when the client can't do the
OAuth sign-in flow — scripts, CI jobs, agents without a browser. For
Claude Code and Claude Desktop, prefer [OAuth](./connect-your-agent.md).

A Connection is administered by an organization **owner**: members can
read through an existing credential, but only owners can mint a new one.

## Creating a key

API keys live on each Collection's **Connect** page, not on a top-level
"API keys" screen.

1. Open the Collection you want the agent to read.
2. Click **Connect this collection** in the header.
3. On the MCP setup page, scroll to **API keys** and click
   **+ API key**. Give it a **Name** that says where it's used
   (`ci-release-bot`, `laptop-cursor`).
4. Click **Generate key**.

The full secret is shown **exactly once**, on the confirmation screen.

> **Copy it now — this is the only time the full key is shown.**

Store it in your secret manager or the client's credential store. Corpus
keeps only a short prefix (`cck_xxxxxxxx`) so you can recognize the key
later; it cannot show or reset the secret. Lose it and you revoke and
create a new one.

## Using a key

Pass it as a bearer token on the MCP endpoint. The same Connect page
generates the exact per-client snippet; the header is always:

```
Authorization: Bearer <YOUR_API_KEY>
```

The token starts with `cck_` so the MCP transport can tell it apart from
an OAuth JWT before doing any database work.

The same key also authenticates the [CLI](./cli.md), which can **edit**
the bound collection's documents from a terminal or CI — list, pull, and
push markdown without a browser.

## Revoking a key

On the Connection's **API keys** list, click **Revoke** on the row and
confirm. Agents using that key lose access immediately. Revoke a key the
moment it might be exposed (a leaked CI log, a former teammate's
laptop) and issue a fresh one — keys are cheap, name them per use so
you can revoke narrowly.

Deleting the whole Connection (Settings → Connections → delete) revokes
every key bound to it and any outstanding OAuth refresh tokens in one
step.
