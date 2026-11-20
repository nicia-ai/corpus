import { and, desc, eq, inArray } from "drizzle-orm";

import type { Grant } from "../grant";
import type {
  ApiKeyId,
  ConnectionId,
  OrganizationId,
  ProjectId,
  UserId,
} from "../ids";
import { asApiKeyId } from "../ids";
import { sha256 } from "../util";

import type { ControlDb } from "./db";
import { apiKey, connection } from "./schema/app";

// MCP API-key token format. The `cck_` prefix lets the `/mcp` transport
// cheaply tell an API key apart from an OAuth JWT (which is dot-delimited
// base64url) before doing any DB work, and signals the credential type
// to humans pasting it into an agent config. 32 random bytes of entropy.
export const API_KEY_PREFIX = "cck_";
const TOKEN_BYTES = 32;
const DISPLAY_PREFIX_LEN = 12;

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateApiKeyToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return `${API_KEY_PREFIX}${base64url(bytes)}`;
}

// What we persist for lookup. The plaintext token is shown to the user
// exactly once and never stored; `sha256` returns a `sha256:`-prefixed
// hex string used verbatim as the unique `token_hash` value.
export function hashApiKeyToken(token: string): Promise<string> {
  return sha256(token);
}

// Short, non-secret identifier shown in the key list so a user can tell
// which row maps to which pasted secret without revealing it.
export function apiKeyDisplayPrefix(token: string): string {
  return token.slice(0, DISPLAY_PREFIX_LEN);
}

// — CRUD ——————————————————————————————————————————————————————————

// A list row's persistence-side fields. The plaintext secret is never
// here — only its short, non-secret display prefix.
export type ApiKeyRow = Readonly<{
  id: ApiKeyId;
  name: string;
  tokenPrefix: string;
  grant: Grant;
  createdAt: Date;
}>;

// Owner-scoped list of a user's keys against ONE Connection. The
// transport projects the rows into a serializable DTO; this query is the
// only Drizzle path so the user-scoping (`apiKey.userId = ...`) cannot
// drift across surfaces.
export async function listApiKeys(
  db: ControlDb,
  userId: UserId,
  connectionId: ConnectionId,
): Promise<readonly ApiKeyRow[]> {
  const rows = await db
    .select({
      id: apiKey.id,
      name: apiKey.name,
      tokenPrefix: apiKey.tokenPrefix,
      grant: apiKey.grant,
      createdAt: apiKey.createdAt,
    })
    .from(apiKey)
    .where(
      and(eq(apiKey.userId, userId), eq(apiKey.connectionId, connectionId)),
    )
    .orderBy(desc(apiKey.createdAt));
  return rows.map((r) => ({
    id: asApiKeyId(r.id),
    name: r.name,
    tokenPrefix: r.tokenPrefix,
    grant: r.grant,
    createdAt: r.createdAt,
  }));
}

// Mint one row. Hashing + display-prefix derivation happen here so the
// transport never sees the plaintext shape twice. Returns the new
// row's id (the transport already holds the plaintext for the one-shot
// reveal).
export async function insertApiKey(
  db: ControlDb,
  input: Readonly<{
    userId: UserId;
    organizationId: OrganizationId;
    connectionId: ConnectionId;
    name: string;
    token: string;
    grant: Grant;
  }>,
): Promise<ApiKeyId> {
  const [row] = await db
    .insert(apiKey)
    .values({
      userId: input.userId,
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      name: input.name,
      tokenHash: await hashApiKeyToken(input.token),
      tokenPrefix: apiKeyDisplayPrefix(input.token),
      grant: input.grant,
    })
    .returning({ id: apiKey.id });
  return asApiKeyId(row?.id ?? "");
}

// Owner-scoped delete: the userId predicate makes another user's id a
// no-op rather than a cross-tenant revoke. Hard delete — keys never
// expire, so the row's absence IS revocation.
export async function deleteApiKey(
  db: ControlDb,
  id: ApiKeyId,
  userId: UserId,
): Promise<void> {
  await db
    .delete(apiKey)
    .where(and(eq(apiKey.id, id), eq(apiKey.userId, userId)));
}

// Change what a key may do. Scoped by `(connectionId, projectId)` like the
// rest of Connection administration: the key's Connection must belong to
// `projectId`, so a stray key id from another project is a silent no-op
// (`false`), never a cross-tenant write.
export async function setApiKeyGrant(
  db: ControlDb,
  input: Readonly<{
    id: ApiKeyId;
    connectionId: ConnectionId;
    projectId: ProjectId;
    grant: Grant;
  }>,
): Promise<boolean> {
  const owned = db
    .select({ id: connection.id })
    .from(connection)
    .where(
      and(
        eq(connection.id, input.connectionId),
        eq(connection.projectId, input.projectId),
      ),
    );
  const rows = await db
    .update(apiKey)
    .set({ grant: input.grant })
    .where(
      and(
        eq(apiKey.id, input.id),
        eq(apiKey.connectionId, input.connectionId),
        inArray(apiKey.connectionId, owned),
      ),
    )
    .returning({ id: apiKey.id });
  return rows.length > 0;
}
