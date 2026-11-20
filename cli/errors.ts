// A failure the Node shell maps to a message + exit code. `kind`
// classifies it; `detail` carries the structured fields the shell may want
// (HTTP status, the server's current version on a conflict).
export type CliErrorKind =
  | "not-found"
  | "conflict"
  | "http"
  | "mismatch"
  | "state"
  | "unsafe-path"
  | "unsupported";

export class CliError extends Error {
  constructor(
    readonly kind: CliErrorKind,
    message: string,
    readonly detail: Readonly<{
      status?: number;
      currentVersion?: number;
    }> = {},
  ) {
    super(message);
    this.name = "CliError";
  }
}
