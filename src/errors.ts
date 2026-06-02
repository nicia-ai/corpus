import { isConstraintError, UniquenessError } from "@nicia-ai/typegraph";

// Machine-readable category shared by every application error, so a
// single `instanceof AppError` catch can branch on `kind` uniformly
// (mirrors the standard 6-kind taxonomy without a Result monad or an
// external dependency).
export type ErrorKind =
  | "validation"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "internal";

export abstract class AppError extends Error {
  abstract readonly kind: ErrorKind;
}

// Stale-version save or a racing duplicate (document_slug, doc_version).
// Both mean "someone changed this while you were editing" → HTTP 409 +
// the merge UX. Carries the server's current head so the client can
// re-base.
export class ConflictError extends AppError {
  readonly kind: ErrorKind = "conflict";
  readonly currentVersion: number;
  constructor(currentVersion: number) {
    super(`document changed (server head is ${String(currentVersion)})`);
    this.name = "ConflictError";
    this.currentVersion = currentVersion;
  }
}

// External input passed transport Zod validation but failed a
// semantic content check — currently a malformed leading YAML
// frontmatter fence. Thrown at the server-fn boundary so the team
// never pushes a file whose metadata silently fails downstream
// (`read_document_meta`, the rendered panel). A file with no fence is
// never rejected by this.
export class ValidationError extends AppError {
  readonly kind: ErrorKind = "validation";
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// Server-function request reached a handler without the Cloudflare
// bindings TanStack Start is supposed to inject (a misconfiguration).
export class MissingContextError extends AppError {
  readonly kind: ErrorKind = "internal";
  constructor(message: string) {
    super(message);
    this.name = "MissingContextError";
  }
}

// A server-side invariant the codebase establishes elsewhere failed at
// runtime — e.g. an org-lifecycle hook did not materialize the default
// Project after `createOrganization`. Always indicates a bug in this
// repo or in a library upgrade, not user input; `internal` kind so the
// framework maps it to a 500 with no caller-actionable hint.
export class InternalError extends AppError {
  readonly kind: ErrorKind = "internal";
  constructor(message: string) {
    super(message);
    this.name = "InternalError";
  }
}

// Authenticated, but not allowed to perform this action (e.g. a
// non-owner attempting team management). Distinct from Unauthorized
// (no/!valid session) — the kind taxonomy's `forbidden`.
export class ForbiddenError extends AppError {
  readonly kind: ErrorKind = "forbidden";
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

// An entitlements quota was exceeded for a gated action (the
// `Entitlements` port — src/control/entitlements.ts). The OSS default
// impl never throws this (self-host is unlimited); a hosted composition
// (`corpus-cloud`) injects an impl that does. `forbidden` kind, like
// ForbiddenError, but distinct so callers can branch on the quota case.
export class QuotaExceededError extends AppError {
  readonly kind: ErrorKind = "forbidden";
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

// No valid session, or a session that resolves to no project.
export class UnauthorizedError extends AppError {
  readonly kind: ErrorKind = "unauthorized";
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

// NOT an AppError. Test-only control-flow sentinel: aborts the save
// transaction to prove atomic rollback, then is caught and converted to a
// structured result internally (no rethrow). It never surfaces to a
// caller, so it carries no application-error `kind`.
export class RollbackProbe extends Error {
  constructor() {
    super("rollback probe");
    this.name = "RollbackProbe";
  }
}

// The optimistic-concurrency enforcer is the `DocumentVersion`
// node-unique constraint: TypeGraph signals a collision with a
// structured `UniquenessError` (`code: "UNIQUENESS_VIOLATION"`,
// `category: "constraint"`), NOT a SQLite "UNIQUE constraint failed"
// message. Classify on the structured signal (instanceof / code /
// isConstraintError), never a message regex.
export function isUniqueViolation(err: unknown): boolean {
  if (err instanceof UniquenessError) return true;
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "UNIQUENESS_VIOLATION"
  ) {
    return true;
  }
  return isConstraintError(err);
}
