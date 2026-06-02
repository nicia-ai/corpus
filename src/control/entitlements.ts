// The entitlements seam: a narrow port (like `McpExecutor`, not a
// class) the OSS request paths depend on. The shipped default is
// unbounded; a hosted composition injects a limit-enforcing impl via
// the request-context seam, with no OSS edit.

import { QuotaExceededError } from "../errors";
import type { OrganizationId, ProjectId, UserId } from "../ids";

// The closed action union the port gates. `bundle_export` is
// deliberately absent: export is always unlimited (unconditional data
// portability is a core OSS virtue and is the Nicia bridge itself).
export type EntitlementAction =
  | "document_create"
  | "version_create"
  | "project_create"
  | "member_invite"
  | "api_key_mint"
  | "oauth_client_register"
  | "event_log_append";

export type QuotaInput = Readonly<{
  action: EntitlementAction;
  userId?: UserId | string | undefined;
  organizationId?: OrganizationId | string | undefined;
  projectId?: ProjectId | string | undefined;
  amount?: number | undefined;
  bytes?: number | undefined;
}>;

// `assertWithinQuota` runs *before* the action and is NOT enlisted in
// the DO transaction, so enforcement is deliberately approximate (a
// small bounded overshoot under concurrency is accepted by design — the
// port gates abuse/billing tiers, not correctness invariants). It throws
// `QuotaExceededError` (kind `forbidden`) when an injected impl denies.
export type Entitlements = Readonly<{
  assertWithinQuota: (input: QuotaInput) => Promise<void>;
}>;

// The shipped OSS behavior: every call resolves. Self-host is unlimited.
// Unit-tested as unbounded (test/entitlements.test.ts).
export const unlimitedEntitlements: Entitlements = {
  assertWithinQuota: () => Promise.resolve(),
};

// The single accessor — resolves the injected impl off any
// context-shaped value, or `unlimitedEntitlements` when none. The
// `undefined` source is the Better Auth DCR hook, which has no request
// context (→ unbounded, the OSS default).
export function entitlementsOf(
  source: Readonly<{ entitlements?: Entitlements | undefined }> | undefined,
): Entitlements {
  return source?.entitlements ?? unlimitedEntitlements;
}

export { QuotaExceededError };
