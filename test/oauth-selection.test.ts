import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { connectControlDb } from "../src/control/db";
import {
  handshakeId,
  PENDING_CONNECT_TTL_MS,
  putSelection,
  readPendingConnect,
  readSelection,
  SELECTION_TTL_MS,
  selectionKey,
  writePendingConnect,
} from "../src/control/oauth-selection";

import { createConnection, createOrg, signUp } from "./_helpers";

// C2 wiring 3: the Connection-selection seam. Better Auth's consent
// callbacks cannot see the OAuth query or a connectionId, so the pick
// is carried through D1 keyed by the handshake id (PKCE code_challenge +
// state) extracted from the authorization query + userId.

// A spec-compliant authorization query string (the form the picker page
// is loaded with, including the signing params Better Auth appends).
function authQuery(codeChallenge: string, state: string): string {
  const p = new URLSearchParams();
  p.set("response_type", "code");
  p.set("client_id", "client-abc");
  p.set("scope", "openid profile email");
  p.set("state", state);
  p.set("code_challenge", codeChallenge);
  p.set("code_challenge_method", "S256");
  p.set("prompt", "consent");
  p.set("exp", "1779943886");
  p.set("ba_iat", "1779943286896");
  p.set("sig", "signature-value");
  return `?${p.toString()}`;
}

async function conn(name: string) {
  const userId = await signUp("sel");
  const org = await createOrg(userId, `Org ${name}`);
  const c = await createConnection({
    organizationId: org.organizationId,
    projectId: org.projectId,
  });
  return { userId: userId as string, connectionId: c.connectionId as string };
}

describe("C2 — oauth connection-selection seam", () => {
  it("handshakeId = code_challenge|state; undefined when neither present", () => {
    expect(handshakeId("code_challenge=CC&state=ST")).toBe("CC|ST");
    expect(handshakeId("code_challenge=CC")).toBe("CC|");
    expect(handshakeId("state=ST")).toBe("|ST");
    expect(handshakeId("response_type=code&client_id=abc")).toBeUndefined();
    expect(handshakeId("")).toBeUndefined();
  });

  it("key = sha256(handshakeId)+userId; handshake and user both partition it", async () => {
    const ka = await selectionKey(authQuery("CC", "ST"), "userA");
    expect(ka).toBeDefined();
    expect(ka).toBe(await selectionKey(authQuery("CC", "ST"), "userA"));
    expect(ka).not.toBe(await selectionKey(authQuery("CC2", "ST"), "userA"));
    expect(ka).not.toBe(await selectionKey(authQuery("CC", "ST"), "userB"));
    expect(ka?.endsWith(":userA")).toBe(true);
    expect(await selectionKey("response_type=code", "userA")).toBeUndefined();
  });

  it("key is stable across serialization drift (the whole-query-hash bug)", async () => {
    // Picker URL: original order + signing params.
    const pickerUrl =
      "?response_type=code&client_id=abc&scope=openid+profile&state=ST&code_challenge=CC&code_challenge_method=S256&prompt=consent&exp=1&ba_iat=2&sig=zzz";
    // What consentReferenceId sees from serializeAuthorizationQuery:
    // reordered, prompt stripped, scope narrowed, no signing params.
    const stateQuery =
      "client_id=abc&code_challenge=CC&response_type=code&scope=openid&state=ST";
    expect(await selectionKey(pickerUrl, "u")).toBe(
      await selectionKey(stateQuery, "u"),
    );
  });

  it("write (picker URL) and read (serialized state.query) match despite drift", async () => {
    const db = connectControlDb(env.DB);
    const { userId, connectionId } = await conn("drift");
    const pickerUrl = authQuery("CC456", "ST123");
    const stateQuery =
      "client_id=client-abc&code_challenge=CC456&response_type=code&scope=openid&state=ST123";
    await putSelection(db, pickerUrl, userId, connectionId);
    expect(await readSelection(db, stateQuery, userId)).toBe(connectionId);
  });

  it("putSelection → readSelection returns the bound Connection", async () => {
    const db = connectControlDb(env.DB);
    const { userId, connectionId } = await conn("rt");
    const q = authQuery("rt-cc", "rt-state");
    await putSelection(db, q, userId, connectionId);
    expect(await readSelection(db, q, userId)).toBe(connectionId);
  });

  it("read is idempotent — NOT single-use (consentReferenceId fires twice)", async () => {
    const db = connectControlDb(env.DB);
    const { userId, connectionId } = await conn("idem");
    const q = authQuery("idem-cc", "idem-state");
    await putSelection(db, q, userId, connectionId);
    expect(await readSelection(db, q, userId)).toBe(connectionId);
    expect(await readSelection(db, q, userId)).toBe(connectionId);
  });

  it("two interleaved handshakes for one user never cross-bind", async () => {
    const db = connectControlDb(env.DB);
    const { userId, connectionId: a } = await conn("h1");
    const b = (await conn("h2")).connectionId;
    const qa = authQuery("cc-A", "state-A");
    const qb = authQuery("cc-B", "state-B");
    await putSelection(db, qa, userId, a);
    await putSelection(db, qb, userId, b);
    expect(await readSelection(db, qa, userId)).toBe(a);
    expect(await readSelection(db, qb, userId)).toBe(b);
  });

  it("expired selection → undefined (fail closed → C3 403)", async () => {
    const db = connectControlDb(env.DB);
    const { userId, connectionId } = await conn("ttl");
    const q = authQuery("ttl-cc", "ttl-state");
    const t0 = 1_000_000;
    await putSelection(db, q, userId, connectionId, t0);
    expect(await readSelection(db, q, userId, t0 + 1)).toBe(connectionId);
    expect(
      await readSelection(db, q, userId, t0 + SELECTION_TTL_MS + 1),
    ).toBeUndefined();
  });

  it("pending-connect intent: write/read, userId-keyed, TTL-expires", async () => {
    const db = connectControlDb(env.DB);
    const { userId, connectionId } = await conn("pend");
    const t0 = 2_000_000;
    await writePendingConnect(db, userId, connectionId, t0);
    expect(await readPendingConnect(db, userId, t0 + 1)).toBe(connectionId);
    expect(
      await readPendingConnect(db, userId, t0 + PENDING_CONNECT_TTL_MS + 1),
    ).toBeUndefined();
  });

  it("pending-connect re-write replaces (one row per user)", async () => {
    const db = connectControlDb(env.DB);
    const { userId, connectionId: a } = await conn("pre1");
    const b = (await conn("pre2")).connectionId;
    await writePendingConnect(db, userId, a);
    await writePendingConnect(db, userId, b);
    expect(await readPendingConnect(db, userId)).toBe(b);
  });
});
