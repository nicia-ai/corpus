import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { organization, user } from "./better-auth";

// Application tables we own. Identity (organization, member, invitation,
// user, session, …) is owned by Better Auth and lives in the generated
// `./better-auth` schema — never hand-edited. `project` and `api_key`
// are Nicia-specific (no Better Auth concept) and reference the Better
// Auth `organization`/`user` by id.

const createdAt = integer("created_at", { mode: "timestamp_ms" })
  .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
  .notNull();

// Content-isolation boundary == one ProjectStore data plane instance (DO
// id = project.id). One default project (slug `default`) is materialized
// per organization (by the Better Auth `afterCreateOrganization` hook);
// the UI hides the project selector while a single project exists.
// `status` drives the lazy-init / soft-delete lifecycle; `authEpoch` is
// bumped on destructive events (member removed/role-changed, project
// deleted) so the in-isolate validation cache invalidates near-immediately
// instead of waiting out its TTL. `policy` is the JSON ProjectPolicy
// (retention), null = "forever".
export const project = sqliteTable(
  "project",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: text("status", {
      enum: ["initializing", "ready", "broken", "deleted"],
    })
      .notNull()
      .default("initializing"),
    authEpoch: integer("auth_epoch").notNull().default(0),
    policy: text("policy"),
    createdAt,
  },
  (t) => [uniqueIndex("project_org_slug_idx").on(t.organizationId, t.slug)],
);

// The agent-facing credential unit (v4): a named, owner-administered
// binding of one Project + exactly one Collection. Credentials (an OAuth
// grant and/or API keys) hang off a Connection; a credential resolves
// to a Connection → (projectId, collectionSlug), and that Collection is
// the hard read boundary. There is NO FK to the Collection: Collections
// live in the per-Project ProjectStore DO, not D1 (the existing
// Project↔DO seam), so validity is enforced at resolution + the
// respondMcp preflight (fail closed). Sound only because `CollectionSlug`
// is immutable (a Collection rename never re-slugs and there is no
// Collection-delete path) — `collectionSlug` is a stable, never-renamed,
// non-FK string pointer. `Connection → Collection` is many-to-one; the
// partial unique index keys the one canonical Connection per Collection
// on the immutable slug + a flag (never the mutable `name`), so a later
// Collection rename can never spawn a second canonical row. Advanced
// Connections are `isDefaultForCollection = false` and unconstrained.
export const connection = sqliteTable(
  "connection",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    collectionSlug: text("collection_slug").notNull(),
    name: text("name").notNull(),
    isDefaultForCollection: integer("is_default_for_collection", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    createdAt,
  },
  (t) => [
    uniqueIndex("connection_default_per_collection_idx")
      .on(t.projectId, t.collectionSlug)
      .where(sql`${t.isDefaultForCollection}`),
  ],
);

// A long-lived MCP credential the user mints for an agent. Acts as the
// owning user, but reaches the data plane THROUGH a Connection — the
// Connection carries the (projectId, collectionSlug) target, never the key
// directly (v4: Project is no longer a credential target). The secret
// is never stored: only its sha256 (`tokenHash`, unique → the lookup
// key) and a short display `tokenPrefix`. Revoke = delete the row (keys
// never expire). Cascades off user/org/connection so removing any of
// them invalidates the key.
export const apiKey = sqliteTable(
  "api_key",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connection.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    createdAt,
  },
  (t) => [uniqueIndex("api_key_token_hash_idx").on(t.tokenHash)],
);

// The Connection-selection state seam. Better Auth's
// `consentReferenceId`/`postLogin.shouldRedirect` callbacks see only
// `{ user, session, scopes }` — never the in-flight OAuth query or a
// connectionId — so the owner's pick must be carried explicitly across
// the handshake in D1.
//
// `pendingConnect`: the Collection-page "Connect this collection"
// intent, written BEFORE the client's OAuth flow exists, so it can only
// be keyed by `userId` (Corpus has no in-flight `state`/PKCE to key to).
// `/connect/select` reads it to PRE-SELECT — it deliberately does NOT
// bind (a userId-keyed hint cannot safely bind: that reopens the
// concurrent-handshake hazard). Short TTL, swept by control-retention.
export const pendingConnect = sqliteTable("pending_connect", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  connectionId: text("connection_id")
    .notNull()
    .references(() => connection.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

// `oauthConnectionSelection`: the actual binding row. Keyed by
// `sha256(handshakeId) + userId`, where `handshakeId` is the in-flight
// authorization-request identity — the PKCE `code_challenge` + `state`,
// the two params that survive every re-serialization of the query across
// the picker / continue / consent legs (see `handshakeId` in
// `oauth-selection.ts`) — PLUS the user, so two concurrent handshakes in
// one browser cannot cross-bind. NOT single-use on read:
// Better Auth invokes `consentReferenceId` more than once per flow, so
// deleting on first read would unbind the later leg — cleanup is
// TTL-only (control-retention sweep).
export const oauthConnectionSelection = sqliteTable(
  "oauth_connection_selection",
  {
    selectionKey: text("selection_key").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connection.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
);

// Append-only admin action log — the enterprise visibility/audit
// promise. Every privileged mutation from the admin dashboard (ban,
// set-role, impersonate, revoke session, delete) writes one row.
// `actorUserId`/`targetId` are stored as bare ids (no FK cascade) so the
// record survives deletion of the actor or target — an audit trail must
// outlive what it describes. `metadata` is action-specific JSON.
export const adminAudit = sqliteTable(
  "admin_audit",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    actorUserId: text("actor_user_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    metadata: text("metadata"),
    createdAt,
  },
  (t) => [index("admin_audit_created_at_idx").on(t.createdAt)],
);

export type Project = Readonly<typeof project.$inferSelect>;
export type Connection = Readonly<typeof connection.$inferSelect>;
export type ApiKey = Readonly<typeof apiKey.$inferSelect>;
export type PendingConnect = Readonly<typeof pendingConnect.$inferSelect>;
export type AdminAudit = Readonly<typeof adminAudit.$inferSelect>;
