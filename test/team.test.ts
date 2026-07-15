import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getAuth } from "../src/auth.server";
import { connectControlDb } from "../src/control/db";
import { membershipCount } from "../src/control/project-admin";
import { resolveProject } from "../src/control/project-resolution";
import { invitation } from "../src/control/schema/better-auth";
import { createTeamInvitation } from "../src/lib/server/team.server";

import { signUpSession } from "./_helpers";

// End-to-end through the real Better Auth organization plugin: org
// creation fires `afterCreateOrganization` (materializes the project),
// invite is email-bound, accept adds a `member`, remove fires
// `afterRemoveMember` (epoch bump → prompt revoke). Verifies the plugin
// ⇄ Nicia `project`/tenancy seam, not mocks.
describe("team management — Better Auth org plugin ⇄ tenancy", () => {
  async function bootstrapOrg(label: string) {
    const owner = await signUpSession(`owner-${label}`);
    await getAuth(env).api.createOrganization({
      body: { name: `Org ${label}`, slug: `org-${label}-${owner.userId}` },
      headers: owner.headers,
    });
    const ref = await resolveProject(
      connectControlDb(env.DB),
      async () => ({ user: { id: owner.userId } }),
      new Headers({ authorization: `Bearer ${label}-owner` }),
    );
    if (ref === undefined) throw new Error("project did not materialize");
    return { owner, ref };
  }

  it("create org materializes a project; invite→accept adds a member", async () => {
    const { owner, ref } = await bootstrapOrg("a");
    const db = connectControlDb(env.DB);
    expect(ref.role).toBe("owner");
    expect(await membershipCount(db, ref.organizationId)).toBe(1);

    const invitee = await signUpSession("invitee-a");
    const inv = await getAuth(env).api.createInvitation({
      body: {
        email: invitee.email,
        role: "member",
        organizationId: ref.organizationId,
      },
      headers: owner.headers,
    });

    await getAuth(env).api.acceptInvitation({
      body: { invitationId: inv.id },
      headers: invitee.headers,
    });

    expect(await membershipCount(db, ref.organizationId)).toBe(2);
    const inviteeRef = await resolveProject(
      db,
      async () => ({ user: { id: invitee.userId } }),
      new Headers({ authorization: "Bearer a-invitee" }),
    );
    expect(inviteeRef?.projectId).toBe(ref.projectId);
    expect(inviteeRef?.role).toBe("member");
  });

  it("acceptance is email-bound — a non-recipient is rejected", async () => {
    const { owner, ref } = await bootstrapOrg("b");
    const db = connectControlDb(env.DB);
    const inv = await getAuth(env).api.createInvitation({
      body: {
        email: `someone-else-${ref.organizationId}@example.com`,
        role: "member",
        organizationId: ref.organizationId,
      },
      headers: owner.headers,
    });

    const wrong = await signUpSession("wrong-b");
    // On the deny path better-call rejects an internal promise that
    // surfaces as an unhandled rejection regardless of how the outer
    // call is consumed (a library artifact, not our code). Scope-guard
    // exactly the expected recipient-mismatch error for this assertion.
    const onUnhandled = (reason: unknown) => {
      const code = (reason as { body?: { code?: string } } | undefined)?.body
        ?.code;
      if (code !== "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION") throw reason;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await getAuth(env).api.acceptInvitation({
        body: { invitationId: inv.id },
        headers: wrong.headers,
        asResponse: true,
      });
      expect(res.status).toBe(403);
      // Let the library's internal rejection settle into our guard.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    // Membership unchanged — the wrong user did not slip in.
    expect(await membershipCount(db, ref.organizationId)).toBe(1);
  });

  it.each([
    ["not-configured", { sent: false as const, reason: "not-configured" }],
    ["send-failed", { sent: false as const, reason: "send-failed" }],
    ["sent", { sent: true as const }],
  ])(
    "creates the invitation before reporting invite email %s",
    async (label, sendResult) => {
      const { owner, ref } = await bootstrapOrg(`mail-${label}`);
      const email = `mail-${label}-${ref.organizationId}@example.com`;
      const sentMessages: { to: string; text: string }[] = [];

      const result = await createTeamInvitation({
        api: getAuth(env).api,
        headers: owner.headers,
        organizationId: ref.organizationId,
        env,
        email,
        role: "member",
        mailer: (_env, message) => {
          sentMessages.push({ to: message.to, text: message.text });
          return Promise.resolve(sendResult);
        },
      });

      expect(result.inviteUrl).toMatch(/\/invite\/.+/);
      expect(result.email).toBe(email);
      expect(result.emailSent).toBe(sendResult.sent);
      if (sendResult.sent) {
        expect("emailReason" in result).toBe(false);
      } else {
        expect(result.emailReason).toBe(sendResult.reason);
      }
      expect(sentMessages).toEqual([
        { to: email, text: expect.stringContaining(result.inviteUrl) },
      ]);

      const invitationId = result.inviteUrl.split("/invite/")[1];
      expect(invitationId).toBeDefined();
      const rows = await connectControlDb(env.DB)
        .select({ email: invitation.email, status: invitation.status })
        .from(invitation)
        .where(eq(invitation.id, invitationId ?? ""));
      expect(rows).toEqual([{ email: email.toLowerCase(), status: "pending" }]);
    },
  );

  it("removing a member fires the epoch hook → access denied promptly", async () => {
    const { owner, ref } = await bootstrapOrg("c");
    const db = connectControlDb(env.DB);
    const invitee = await signUpSession("invitee-c");
    const inv = await getAuth(env).api.createInvitation({
      body: {
        email: invitee.email,
        role: "member",
        organizationId: ref.organizationId,
      },
      headers: owner.headers,
    });
    await getAuth(env).api.acceptInvitation({
      body: { invitationId: inv.id },
      headers: invitee.headers,
    });

    const getInvitee = async () => ({ user: { id: invitee.userId } });
    const headers = new Headers({ authorization: "Bearer c-invitee" });
    expect((await resolveProject(db, getInvitee, headers))?.projectId).toBe(
      ref.projectId,
    );

    await getAuth(env).api.removeMember({
      body: {
        memberIdOrEmail: invitee.email,
        organizationId: ref.organizationId,
      },
      headers: owner.headers,
    });

    // afterRemoveMember bumped the project epoch → the cached ref is
    // dropped and re-resolve finds no membership.
    expect(await resolveProject(db, getInvitee, headers)).toBeUndefined();
    expect(await membershipCount(db, ref.organizationId)).toBe(1);
  });
});
