import { ConflictError } from "../../errors";

// Optimistic-concurrency gate. The client must have loaded the current
// head; any drift is a 409 carrying the server's version so the client
// can re-base.
export function nextVersion(
  head: { readonly docVersion: number } | undefined,
  clientVersion: number,
): number {
  const current = head?.docVersion ?? 0;
  if (clientVersion !== current) throw new ConflictError(current);
  return current + 1;
}
