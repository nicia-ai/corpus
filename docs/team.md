---
title: Your team
description: Invite teammates into your organization so everyone shares one canonical collection — roles, the invite-link flow, and managing members.
sidebar:
  order: 7
---

Everyone in your organization shares its canonical collection. Inviting
your team is how non-engineers contribute the knowledge and engineers
keep agents pointed at it.

## Roles

| Role       | Can                                                                            |
| ---------- | ------------------------------------------------------------------------------ |
| **Member** | Read and write documents and collections, manage their own API keys.           |
| **Owner**  | Everything a member can, plus invite people, change roles, and remove members. |

## Inviting someone

On the **Team** page (owners only), under **Invite a teammate**, enter
the person's **Email**, pick a **Role**, and click **Create invite**.

Corpus does **not** send the email. It shows you an **invite link
once** — copy it and send it to the person however you normally would
(Slack, email, etc.). The link is shown a single time per invite; if you
lose it, revoke and re-invite.

The invitation is bound to the email you entered. The recipient must
sign up or sign in **with that exact address** to accept — a leaked link
can't be claimed by the wrong person. That binding is intentional, not a
limitation.

## Accepting an invitation

The recipient opens the link:

- **Not signed in?** They're prompted to create an account or sign in —
  with the invited email — and land back on the accept screen.
- **Signed in as the invited email?** They click **Accept invitation**
  and join the team.
- **Signed in as someone else?** They'll see _"This invitation was sent
  to a different email."_ — they sign in with the right address and open
  the link again.

Expired or already-used links show a clear message; an owner just sends
a new invite.

## Managing members

On the **Team** page, an owner can:

- **Change a role** — the dropdown next to a member.
- **Remove a member** — the **Remove** action on their row. They lose
  access immediately; any agent using a key they minted stops working.
- **Revoke a pending invitation** — under **Pending invitations**,
  before it's accepted.

The organization always keeps at least one owner — you can't remove or
demote the last one.
