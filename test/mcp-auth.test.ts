import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// A2 seam: discovery is reachable and the MCP endpoint refuses
// unauthenticated callers. The full OAuth dance + valid-token path is
// Better Auth's own tested surface; the token.sub → project → DO mapping
// reuses resolveProject, already covered by control.test.ts.
describe("A2 — OAuth-provider MCP auth seam", () => {
  it("publishes oauth-authorization-server discovery metadata", async () => {
    const res = await SELF.fetch(
      "https://example.com/.well-known/oauth-authorization-server",
    );
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(typeof meta["issuer"]).toBe("string");
    expect(typeof meta["authorization_endpoint"]).toBe("string");
  });

  it("publishes openid-configuration", async () => {
    const res = await SELF.fetch(
      "https://example.com/.well-known/openid-configuration",
    );
    expect(res.status).toBe(200);
  });

  it("rejects an unauthenticated MCP request", async () => {
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});
