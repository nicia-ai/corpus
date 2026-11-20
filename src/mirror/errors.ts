import { AppError, type ErrorKind } from "../errors";

// Failures of the Git mirror. All are AppErrors so transports classify them
// on `kind` / `instanceof`, never on a message. "Off" and "not ready yet" are
// not failures: they travel as results, with the messages below.

export const MIRROR_NOT_ENABLED_MESSAGE =
  "The Git mirror is not enabled on this server.";
export const MIRROR_NOT_READY_MESSAGE =
  "The Git mirror for this corpus is not ready yet; try again shortly.";

// The receiver refused the push for a reason that retrying will not fix
// (an unpack failure, a limit, a policy).
export class MirrorPushRejectedError extends AppError {
  readonly kind: ErrorKind = "internal";
  constructor(readonly reason: string) {
    super(`Git push rejected: ${reason}`);
    this.name = "MirrorPushRejectedError";
  }
}

// The corpus is larger than one push can carry.
export class MirrorTooLargeError extends AppError {
  readonly kind: ErrorKind = "internal";
  constructor(message: string) {
    super(message);
    this.name = "MirrorTooLargeError";
  }
}

// Artifacts (the binding or its Git endpoint) failed or answered
// unexpectedly. Transient by assumption: the drain retries with backoff.
export class MirrorServiceError extends AppError {
  readonly kind: ErrorKind = "internal";
  constructor(message: string, options?: Readonly<{ cause: unknown }>) {
    super(message, options);
    this.name = "MirrorServiceError";
  }
}
