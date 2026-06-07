import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createOrg, signUp, signUpSession } from "./_helpers";

// The real-time channel authenticates the WS upgrade at the Worker BEFORE
// forwarding to the per-Project DO — the DO never sees an unauthenticated
// socket. This exercises that gate (`GET /api/ws/:projectId` in src/api.ts):
//   - no `Upgrade: websocket`        → 426 (checked first, before auth)
//   - upgrade but no session         → 401
//   - upgrade + session, not a member → 403
// The success path (101 → DO) is the WS lifecycle, covered elsewhere.

const WS_HEADERS = { upgrade: "websocket" } as const;

function ws(
  projectId: string,
  headers: Record<string, string>,
): Promise<Response> {
  return SELF.fetch(`https://example.com/api/ws/${projectId}`, { headers });
}

describe("WS auth gate (GET /api/ws/:projectId)", () => {
  it("426s a request that is not a websocket upgrade", async () => {
    const res = await ws("any-project", {});
    expect(res.status).toBe(426);
  });

  it("401s an upgrade with no session", async () => {
    const res = await ws("any-project", WS_HEADERS);
    expect(res.status).toBe(401);
  });

  it("403s an upgrade whose session is not a member of the project", async () => {
    // A signed-in user, and a project owned by someone else entirely.
    const intruder = await signUpSession("ws-intruder");
    const strangerId = await signUp("ws-stranger");
    const foreign = await createOrg(strangerId, "Stranger Org");

    const res = await ws(foreign.projectId, {
      ...WS_HEADERS,
      cookie: intruder.headers.get("cookie") ?? "",
    });
    expect(res.status).toBe(403);
  });
});
