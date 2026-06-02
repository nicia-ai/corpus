import { describe, expect, it } from "vitest";

import type { ProjectRef } from "../src/control/refs";
import { ForbiddenError, UnauthorizedError } from "../src/errors";
import {
  asOrganizationId,
  asProjectId,
  asUserId,
  type OrganizationId,
  type ProjectId,
} from "../src/ids";
import { requireProjectOwner } from "../src/lib/server/shared";

// Owner-gate primitive (`src/lib/server/shared.ts`). Every server fn that
// administers a Connection (`renameConnection`, `deleteConnection`,
// `connectThisCollection`), mints an API key (`createApiKey`), or moves
// a bundle (`exportBundle`, `importBundle`) routes through this. The
// cross-tenant SQL scope is pinned in `connections-cross-tenant.test.ts`;
// here we pin the role/auth check itself so a refactor that quietly
// loses the `requireProjectOwner` call (or relaxes its semantics) cannot
// ship green.

function ref(role: ProjectRef["role"]): ProjectRef {
  const organizationId: OrganizationId = asOrganizationId("org-1");
  const projectId: ProjectId = asProjectId("proj-1");
  return {
    organizationId,
    projectId,
    userId: asUserId("user-1"),
    role,
  };
}

describe("requireProjectOwner", () => {
  it("returns the ref unchanged when the caller is an owner", () => {
    const r = ref("owner");
    expect(requireProjectOwner(r, "nope")).toBe(r);
  });

  it("throws ForbiddenError with the caller-supplied message for a member", () => {
    expect(() =>
      requireProjectOwner(ref("member"), "Only an owner can X"),
    ).toThrow(ForbiddenError);
    try {
      requireProjectOwner(ref("member"), "Only an owner can X");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      if (err instanceof ForbiddenError) {
        expect(err.kind).toBe("forbidden");
        expect(err.message).toBe("Only an owner can X");
        expect(err.name).toBe("ForbiddenError");
      }
    }
  });

  it("throws UnauthorizedError when the ref is undefined (no project resolved)", () => {
    expect(() => requireProjectOwner(undefined, "msg")).toThrow(
      UnauthorizedError,
    );
    try {
      requireProjectOwner(undefined, "msg");
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedError);
      if (err instanceof UnauthorizedError) {
        expect(err.kind).toBe("unauthorized");
        // The message is fixed; the caller-supplied forbiddenMessage is only
        // for the role-check branch.
        expect(err.message).toBe("No project");
      }
    }
  });
});
