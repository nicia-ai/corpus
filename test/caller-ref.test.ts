import { describe, expect, it } from "vitest";

import {
  asApiKeyId,
  asConnectionId,
  asUserId,
  type CallerRef,
  callerRefFromApiKey,
  callerRefFromOAuth,
} from "../src/ids";

// Pure-domain tests — no DO, no D1. The CallerRef is the namespaced
// caller identity threaded api.ts → scopedExecutor → the durable event
// stream. Two auth paths produce CallerRefs in their own namespace so
// an api_key id can never collide with an OAuth sub.

describe("CallerRef — construction is namespaced", () => {
  it("API-key path produces `apikey:<api_key.id>`", () => {
    const apiKeyId = asApiKeyId("a1b2c3d4");
    expect(callerRefFromApiKey(apiKeyId)).toBe("apikey:a1b2c3d4");
  });

  it("OAuth path includes the Connection in its caller identity", () => {
    const userId = asUserId("user-abc-123");
    expect(callerRefFromOAuth(userId, asConnectionId("conn-1"))).toBe(
      "oauth:user-abc-123:connection:conn-1",
    );
  });

  it("an api_key id and an oauth sub with the same raw string DO NOT collide", () => {
    // Hypothetical pathological case: an api_key id and a user id that
    // happen to share the same suffix. The namespace prefix is the
    // entire point — these MUST be distinct CallerRefs.
    const sharedSuffix = "abc-123";
    const a: CallerRef = callerRefFromApiKey(asApiKeyId(sharedSuffix));
    const b: CallerRef = callerRefFromOAuth(
      asUserId(sharedSuffix),
      asConnectionId("conn-1"),
    );
    expect(a).not.toBe(b);
    expect(a).toBe("apikey:abc-123");
    expect(b).toBe("oauth:abc-123:connection:conn-1");
  });

  it("scopes the same OAuth user to distinct Connections", () => {
    const userId = asUserId("user-1");
    expect(callerRefFromOAuth(userId, asConnectionId("conn-a"))).not.toBe(
      callerRefFromOAuth(userId, asConnectionId("conn-b")),
    );
  });

  it("CallerRefs round-trip as their string form (opaque to downstream)", () => {
    // Downstream code (event emission, the event-log's caller column)
    // treats CallerRef as an opaque string. The brand is type-level
    // only; the runtime value IS the namespaced string.
    const a: CallerRef = callerRefFromApiKey(asApiKeyId("k1"));
    expect(typeof a).toBe("string");
    expect(String(a)).toBe("apikey:k1");
  });
});
