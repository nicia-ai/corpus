import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// C2 wiring 1 + 2: discovery must work from a cold 401, and
// unauthenticated DCR must succeed (every shipping MCP client is
// DCR-first and registers before any user session exists).

const ORIGIN = "https://example.com";

describe("C2 — OAuth discovery (RFC 9728 PRM + cold 401)", () => {
  it.each([
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ])("serves Protected Resource Metadata at %s", async (path) => {
    const res = await SELF.fetch(`${ORIGIN}${path}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      authorization_servers?: string[];
    };
    expect(typeof body.resource).toBe("string");
    expect(body.resource.endsWith("/mcp")).toBe(true);
    expect(Array.isArray(body.authorization_servers)).toBe(true);
    expect(body.authorization_servers?.length ?? 0).toBeGreaterThan(0);
  });

  it("a cold MCP request (no token) → 401 with a WWW-Authenticate challenge", async () => {
    const res = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate");
    expect(challenge).toBeTruthy();
    // The challenge MUST point a client at the protected-resource
    // metadata so it can discover the AS.
    expect(challenge?.toLowerCase()).toContain("resource_metadata");
  });

  it("unauthenticated DCR succeeds at /api/auth/oauth2/register", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:33418/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "ci-dcr-client",
      }),
    });
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { client_id?: string };
    expect(typeof body.client_id).toBe("string");
    expect(body.client_id?.length ?? 0).toBeGreaterThan(0);
  });
});
