import { and, eq, gt } from "drizzle-orm";

import { sha256 } from "../util";

import type { ControlDb } from "./db";
import { oauthConnectionSelection, pendingConnect } from "./schema/app";

// The Connection-selection state seam. Better Auth's consent /
// post-login callbacks cannot see the OAuth query or a connectionId,
// so the owner's pick is carried through D1. Two rows, two purposes —
// see schema/app.ts. Both are short-lived and joined to the existing
// control-retention sweep (TTL-only, never deleted on read:
// `consentReferenceId` fires multiple times per flow).

// The custom access-token claim that carries the bound Connection.
// Spec-compliant audience stays the single fixed `${base}/mcp`; the
// Connection is this orthogonal namespaced claim. One definition so the
// stamp (auth.ts customAccessTokenClaims) and the read (api.ts OAuth
// path) can never drift.
export const connectionClaimKey = (base: string): string =>
  `${base}/connection`;

// Short — these rows live only across a single in-flight handshake.
export const SELECTION_TTL_MS = 10 * 60 * 1000;
export const PENDING_CONNECT_TTL_MS = 10 * 60 * 1000;

// The stable per-handshake identifier extracted from an in-flight
// authorization query. We key on the PKCE `code_challenge` plus `state`
// — NOT the whole query — because the query string is re-serialized
// differently in each context that reads it back: the consent endpoint
// sees the before-hook's sig-stripped `URLSearchParams.toString()`, while
// `consentReferenceId`/`shouldRedirect` invoked from inside
// `authorizeEndpoint` see `serializeAuthorizationQuery()` (reordered,
// `prompt` stripped, `scope` narrowed to consented scopes). A whole-query
// hash would therefore never match between the picker write and the
// consent read. `code_challenge` (fresh per handshake, S256, high entropy)
// and `state` survive every transform untouched, so they are the join key.
// Returns undefined when the query carries neither — i.e. it is not a
// spec-compliant authorization handshake — so callers fail closed.
export function handshakeId(query: string): string | undefined {
  const params = new URLSearchParams(query);
  const codeChallenge = params.get("code_challenge") ?? "";
  const state = params.get("state") ?? "";
  if (codeChallenge === "" && state === "") return undefined;
  return `${codeChallenge}|${state}`;
}

// Key = sha256(handshakeId) + userId. The `+ userId` narrows any residual
// collision to one user driving two byte-identical concurrent handshakes —
// negligible, and still fail-closed (wrong-Connection bind impossible;
// worst case is no row → 403). Undefined when the query is not a handshake.
export async function selectionKey(
  query: string,
  userId: string,
): Promise<string | undefined> {
  const id = handshakeId(query);
  if (id === undefined) return undefined;
  return `${await sha256(id)}:${userId}`;
}

// — Pending-connect intent (userId-keyed). Written by the
// Collection-page "Connect this collection" action before any OAuth
// flow exists; read by /connect/select to PRE-SELECT (never to bind).

export async function writePendingConnect(
  db: ControlDb,
  userId: string,
  connectionId: string,
  nowMs: number = Date.now(),
): Promise<void> {
  const expiresAt = new Date(nowMs + PENDING_CONNECT_TTL_MS);
  await db
    .insert(pendingConnect)
    .values({ userId, connectionId, expiresAt })
    .onConflictDoUpdate({
      target: pendingConnect.userId,
      set: { connectionId, expiresAt },
    });
}

export async function readPendingConnect(
  db: ControlDb,
  userId: string,
  nowMs: number = Date.now(),
): Promise<string | undefined> {
  const [row] = await db
    .select({ connectionId: pendingConnect.connectionId })
    .from(pendingConnect)
    .where(
      and(
        eq(pendingConnect.userId, userId),
        gt(pendingConnect.expiresAt, new Date(nowMs)),
      ),
    )
    .limit(1);
  return row?.connectionId;
}

// — Selection row (sha256(handshakeId)+userId-keyed). The actual binding the
// consent callback reads. Idempotent put; idempotent read (NOT
// single-use).

export async function putSelection(
  db: ControlDb,
  query: string,
  userId: string,
  connectionId: string,
  nowMs: number = Date.now(),
): Promise<void> {
  const key = await selectionKey(query, userId);
  if (key === undefined) return;
  const expiresAt = new Date(nowMs + SELECTION_TTL_MS);
  await db
    .insert(oauthConnectionSelection)
    .values({ selectionKey: key, connectionId, expiresAt })
    .onConflictDoUpdate({
      target: oauthConnectionSelection.selectionKey,
      set: { connectionId, expiresAt },
    });
}

export async function readSelection(
  db: ControlDb,
  query: string,
  userId: string,
  nowMs: number = Date.now(),
): Promise<string | undefined> {
  const key = await selectionKey(query, userId);
  if (key === undefined) return undefined;
  const [row] = await db
    .select({ connectionId: oauthConnectionSelection.connectionId })
    .from(oauthConnectionSelection)
    .where(
      and(
        eq(oauthConnectionSelection.selectionKey, key),
        gt(oauthConnectionSelection.expiresAt, new Date(nowMs)),
      ),
    )
    .limit(1);
  return row?.connectionId;
}
