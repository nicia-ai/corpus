// Branded identifiers. Two strings are NOT interchangeable just because
// both are `string`: a ProjectId is not a UserId, a CollectionSlug is not
// a DocumentSlug. The brand is type-level only (zero runtime cost — the
// constructors are identity functions).
//
// Rule: a raw `string` becomes a branded id ONLY via the matching `as*`
// constructor, and ONLY at a boundary where the value is known to be that
// id — a DB read, a Zod-validated input, or the auth session. Internal
// code then passes the branded type around and the compiler prevents
// mixing. The casts here are the single sanctioned place (same
// containment principle as `asLedgerDb`); never cast to a branded type
// anywhere else.

declare const brand: unique symbol;
type Branded<B extends string> = Readonly<{ [brand]: B }>;
export type Id<B extends string> = string & Branded<B>;

export type OrganizationId = Id<"OrganizationId">;
export type ProjectId = Id<"ProjectId">;
export type UserId = Id<"UserId">;
export type DocumentSlug = Id<"DocumentSlug">;
export type CollectionSlug = Id<"CollectionSlug">;
export type FolderSlug = Id<"FolderSlug">;
// A block within a document version. Block ids are derived, non-canonical
// side state (not part of the bundle / MCP surface): minted by the block
// matcher when a new block appears and carried forward across versions so
// comment / suggestion anchors survive edits and moves.
export type BlockId = Id<"BlockId">;
export type ApiKeyId = Id<"ApiKeyId">;
export type ConnectionId = Id<"ConnectionId">;
// Better Auth organization-plugin entities: a `member` row id and an
// `invitation` id. Owned by the plugin (not hand-rolled) but branded
// here so the web/team surface passes them around type-safely.
export type MemberId = Id<"MemberId">;
export type InvitationId = Id<"InvitationId">;

// The per-request identity of an MCP caller, namespaced by auth path
// so an api_key.id can never collide with an OAuth `sub`. Values are
// either `apikey:<api_key.id>` or `oauth:<jwt.sub>` — never the raw
// token, never the OAuth access token. Built once at the auth
// resolver (resolveApiKey / resolveConnection) and threaded end-to-end
// into the scopedExecutor so the durable event stream's read events
// attribute reads to a stable caller.
export type CallerRef = Id<"CallerRef">;

export const asOrganizationId = (s: string): OrganizationId =>
  s as OrganizationId;
export const asProjectId = (s: string): ProjectId => s as ProjectId;
export const asUserId = (s: string): UserId => s as UserId;
export const asApiKeyId = (s: string): ApiKeyId => s as ApiKeyId;
export const asConnectionId = (s: string): ConnectionId => s as ConnectionId;
export const asMemberId = (s: string): MemberId => s as MemberId;
export const asInvitationId = (s: string): InvitationId => s as InvitationId;
export const asDocumentSlug = (s: string): DocumentSlug => s as DocumentSlug;
export const asCollectionSlug = (s: string): CollectionSlug =>
  s as CollectionSlug;
export const asFolderSlug = (s: string): FolderSlug => s as FolderSlug;
export const asBlockId = (s: string): BlockId => s as BlockId;
export const asCallerRef = (s: string): CallerRef => s as CallerRef;

// Construct a CallerRef from an API key id. The single sanctioned site
// where the `apikey:` namespace prefix is written — every other caller
// passes the branded type around.
export function callerRefFromApiKey(apiKeyId: ApiKeyId): CallerRef {
  return asCallerRef(`apikey:${apiKeyId}`);
}

// Construct a CallerRef from an OAuth subject (the `jwt.sub` claim,
// which IS the user id). Symmetric with the API-key path; both
// resolver sites produce a CallerRef that the rest of the system can
// compare as opaque strings.
export function callerRefFromOAuth(userId: UserId): CallerRef {
  return asCallerRef(`oauth:${userId}`);
}

// Decode a stored author id into its kind + bare id — the inverse of the
// two constructors above and the single sanctioned site where the
// `apikey:` / `oauth:` prefixes are READ. Server-side label resolution
// (resolveAuthorLabels and activity-view's labelFor) classifies through
// here instead of re-matching the literals. A bare user id (a web edit's
// author), or a malformed prefix with an empty body, decodes to kind
// "user".
export function parseCallerRef(
  ref: string,
): Readonly<{ kind: "apikey" | "oauth" | "user"; id: string }> {
  if (ref.startsWith("apikey:")) {
    const id = ref.slice("apikey:".length);
    if (id !== "") return { kind: "apikey", id };
  }
  if (ref.startsWith("oauth:")) {
    const id = ref.slice("oauth:".length);
    if (id !== "") return { kind: "oauth", id };
  }
  return { kind: "user", id: ref };
}

// The transport a write arrived through, captured at the endpoint boundary
// — NOT inferred from credential type. A `cck_` key and an OAuth bearer can
// each drive either surface (an api key authenticates `/mcp` too, and a
// future CLI may use OAuth), so the channel is recorded as stored truth at
// write time rather than guessed from the CallerRef prefix later. `web` is
// an authed browser session; `mcp` the agent endpoint; `cli` the REST/CLI
// surface.
export const CALLER_CHANNELS = ["web", "mcp", "cli"] as const;
export type CallerChannel = (typeof CALLER_CHANNELS)[number];
