import { describe, expect, it } from "vitest";

import {
  type EntitlementAction,
  type Entitlements,
  entitlementsOf,
  QuotaExceededError,
  unlimitedEntitlements,
} from "../src/control/entitlements";
import { AppError } from "../src/errors";

const ALL_ACTIONS: readonly EntitlementAction[] = [
  "document_create",
  "version_create",
  "project_create",
  "member_invite",
  "api_key_mint",
  "oauth_client_register",
];

describe("entitlements port — shipped OSS default is unbounded", () => {
  it("unlimitedEntitlements resolves for every action in the closed union", async () => {
    for (const action of ALL_ACTIONS) {
      await expect(
        unlimitedEntitlements.assertWithinQuota({ action }),
      ).resolves.toBeUndefined();
    }
  });

  it("entitlementsOf defaults to unlimited with no injected impl", async () => {
    // The OSS resolution paths: undefined source (the Better Auth DCR
    // hook) and a context with no `entitlements` (every OSS server fn).
    for (const source of [undefined, {}, { entitlements: undefined }]) {
      await expect(
        entitlementsOf(source).assertWithinQuota({ action: "api_key_mint" }),
      ).resolves.toBeUndefined();
    }
    expect(entitlementsOf(undefined)).toBe(unlimitedEntitlements);
  });

  it("entitlementsOf returns an injected impl (the composition seam)", async () => {
    const seen: EntitlementAction[] = [];
    const denying: Entitlements = {
      assertWithinQuota: ({ action }) => {
        seen.push(action);
        return Promise.reject(new QuotaExceededError("over the free tier"));
      },
    };
    const resolved = entitlementsOf({ entitlements: denying });
    expect(resolved).toBe(denying);
    await expect(
      resolved.assertWithinQuota({ action: "document_create" }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
    expect(seen).toEqual(["document_create"]);
  });
});

describe("QuotaExceededError", () => {
  it("is a forbidden-kind AppError with a stable name", () => {
    const e = new QuotaExceededError("limit reached");
    expect(e).toBeInstanceOf(AppError);
    expect(e.kind).toBe("forbidden");
    expect(e.name).toBe("QuotaExceededError");
    expect(e.message).toBe("limit reached");
  });
});
