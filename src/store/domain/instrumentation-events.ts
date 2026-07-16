import { z } from "zod";

import { CollectionMetadataSchema } from "./change-events";

// The typed instrumentation event vocabulary — the **schema** of the
// payload column on the EventLogStore's `event_log` table. Every event
// round-trips through these Zod schemas at the trust boundary (encode
// on write, decode on read) so the log stays the auditable source of
// truth. Envelope fields (schemaVersion, projectId, monotonicId,
// idempotencyKey, timestamp) live on the row, not in the payload body.

// Bumped only when the payload SHAPE breaks back-compat. Adding a new
// variant is NOT a bump (consumers ignore unknown types); changing a
// field on an existing variant IS.
export const INSTRUMENTATION_EVENT_SCHEMA_VERSION = 2;

// — Document lifecycle (existing change-events vocabulary, replayed
// through the durable stream so a consumer subscribing to `document.*`
// gets every save).
const DocumentCreatedSchema = z.object({
  type: z.literal("document.created"),
  slug: z.string(),
  docVersion: z.number().int().positive(),
  title: z.string(),
  contentHash: z.string(),
  changedBy: z.string(),
});

const DocumentUpdatedSchema = z.object({
  type: z.literal("document.updated"),
  slug: z.string(),
  docVersion: z.number().int().positive(),
  title: z.string(),
  contentHash: z.string(),
  changedBy: z.string(),
});

const DocumentRenamedSchema = z.object({
  type: z.literal("document.renamed"),
  slug: z.string(),
  docVersion: z.number().int().positive(),
  title: z.string(),
  changedBy: z.string(),
});

const DocumentArchivedSchema = z.object({
  type: z.literal("document.archived"),
  slug: z.string(),
  docVersion: z.number().int().positive(),
  changedBy: z.string(),
});

const DocumentFilenameChangedSchema = z.object({
  type: z.literal("document.filename_changed"),
  slug: z.string(),
  docVersion: z.number().int().positive(),
  title: z.string(),
  changedBy: z.string(),
});

// — Collection lifecycle. `collection.attached`/`detached` carry
// exactly one of `documentSlug` / `folderSlug` — a member can be either
// a direct document or a folder include (the bridge from the local
// ChangeLog vocabulary in `emitFromCollectionChange` preserves which).
const CollectionCreatedSchema = z.object({
  type: z.literal("collection.created"),
  collectionSlug: z.string(),
  changedBy: z.string(),
});

// `before`/`after` carry every editable head-node field at the time of
// the edit (the canonical `CollectionMetadataSchema` from `change-events.ts`
// is the single shape), so an audit consumer can diff them to know what
// changed (renames, description edits, and `alwaysIncludeBudgetTokens`
// tweaks all flow through this one event). Optional in the wire schema
// so v2-era rows decoded from the log — written before this shape was
// added — stay readable.
const CollectionUpdatedSchema = z.object({
  type: z.literal("collection.updated"),
  collectionSlug: z.string(),
  before: CollectionMetadataSchema.optional(),
  after: CollectionMetadataSchema.optional(),
  changedBy: z.string(),
});

const CollectionAttachedSchema = z.object({
  type: z.literal("collection.attached"),
  collectionSlug: z.string(),
  documentSlug: z.string().optional(),
  folderSlug: z.string().optional(),
  position: z.number().int().nonnegative(),
  changedBy: z.string(),
});

const CollectionDetachedSchema = z.object({
  type: z.literal("collection.detached"),
  collectionSlug: z.string(),
  documentSlug: z.string().optional(),
  folderSlug: z.string().optional(),
  changedBy: z.string(),
});

// `reason` distinguishes the three causes of `collection.reordered`:
//   `drag-reorder`      — explicit member-order change
//   `delivery-changed`  — `core` ↔ `reference` tier flip (member identity stays;
//                         the resolved corpus changes, so it reuses `.reordered`)
//   `folder-tree-changed` — a path-map mutation upstream (folder rename/move/
//                         delete) — every folder-linking collection's resolved
//                         expansion may differ even though no member edge moved
// `documentSlug`/`folderSlug` identify the affected member for `delivery-changed`;
// `delivery` is the new tier. `drag-reorder` carries none of these.
const CollectionReorderedSchema = z.object({
  type: z.literal("collection.reordered"),
  collectionSlug: z.string(),
  reason: z
    .enum(["drag-reorder", "delivery-changed", "folder-tree-changed"])
    .optional(),
  documentSlug: z.string().optional(),
  folderSlug: z.string().optional(),
  delivery: z.enum(["core", "reference"]).optional(),
  changedBy: z.string(),
});

// — The funnel-critical signal: an agent (caller) read a collection.
// `versionCapturedAtRead` is the per-doc {slug: docVersion} snapshot
// the caller actually saw — comparing it against current versions on a
// later read is how the activity view derives Fresh vs Stale
// (evidence-based, never time-based). Only state-change moments are
// emitted; routine repeat reads are silent no-ops:
//   `first`       — this caller's first read of this collection, ever.
//   `after-edit`  — first read after a teammate edit superseded what
//                   this caller had last captured.
const ReadEventSchema = z.object({
  type: z.literal("read"),
  kind: z.enum(["first", "after-edit"]),
  callerRef: z.string(), // `apikey:<api_key.id>` | `oauth:<jwt.sub>:connection:<connection.id>`
  collectionSlug: z.string(),
  versionCapturedAtRead: z.record(z.string(), z.number().int().positive()),
});

// — Caller-connection moments. Distinct from `read.first`: a caller can
// "connect" (auth + first MCP call) before resolving a collection. Emitted
// once per distinct callerRef per project; "second distinct caller
// connects" is the wedge-defining team-rollout signal.
const CallerConnectedSchema = z.object({
  type: z.literal("caller.connected"),
  callerRef: z.string(),
});

// — Post-activation prompt response. One row per team's first answer;
// dismissing without choosing is a separate `bet: "none"` choice.
const PromptAnsweredSchema = z.object({
  type: z.literal("prompt.answered"),
  bet: z.enum([
    "shared-prompts-skills",
    "version-quality-measurement",
    "off-laptop-reactivity",
    "policy-change-approval",
    "none",
  ]),
  answeredBy: z.string(),
});

// The discriminated union — every variant ABOVE, no others. New event
// types added to the stream MUST land here and through encodeEvent /
// decodeEvent; an `any` escape hatch would defeat the auditability
// guarantee the type column on event_log gives consumers.
export const InstrumentationEventSchema = z.discriminatedUnion("type", [
  DocumentCreatedSchema,
  DocumentUpdatedSchema,
  DocumentRenamedSchema,
  DocumentArchivedSchema,
  DocumentFilenameChangedSchema,
  CollectionCreatedSchema,
  CollectionUpdatedSchema,
  CollectionAttachedSchema,
  CollectionDetachedSchema,
  CollectionReorderedSchema,
  ReadEventSchema,
  CallerConnectedSchema,
  PromptAnsweredSchema,
]);

export type InstrumentationEvent = Readonly<
  z.infer<typeof InstrumentationEventSchema>
>;

// The `eventType` value stored in the event_log row's indexed column.
// For the read variant we surface `read.first` / `read.after-edit` so
// the column is filterable at the kind level, not just the parent type.
export function eventType(event: InstrumentationEvent): string {
  if (event.type === "read") return `read.${event.kind}`;
  return event.type;
}

// Encode: validate at the write boundary, then JSON-serialize for the
// payload column. Throws on a malformed event (the caller built an
// event the union does not cover) — the trust boundary catches this
// before anything reaches the durable log.
export function encodeEvent(event: InstrumentationEvent): string {
  return JSON.stringify(InstrumentationEventSchema.parse(event));
}

// Decode: parse the payload string back into a typed event. Throws on
// a payload that does not validate — a corrupt or schema-evolved row
// surfaces here, never silently. The caller (consumer / projection
// fold) can opt to skip-and-log instead of fail.
export function decodeEvent(payload: string): InstrumentationEvent {
  return InstrumentationEventSchema.parse(JSON.parse(payload) as unknown);
}

// Convenience builders. Keep callers from drifting on field names by
// constraining at the type level; the encode boundary still validates
// via Zod. Each builder returns the typed variant ready for
// encodeEvent + eventLogStore.append.
export const events = {
  documentCreated: (
    fields: Omit<z.infer<typeof DocumentCreatedSchema>, "type">,
  ): InstrumentationEvent => ({ type: "document.created", ...fields }),
  documentUpdated: (
    fields: Omit<z.infer<typeof DocumentUpdatedSchema>, "type">,
  ): InstrumentationEvent => ({ type: "document.updated", ...fields }),
  documentRenamed: (
    fields: Omit<z.infer<typeof DocumentRenamedSchema>, "type">,
  ): InstrumentationEvent => ({ type: "document.renamed", ...fields }),
  documentArchived: (
    fields: Omit<z.infer<typeof DocumentArchivedSchema>, "type">,
  ): InstrumentationEvent => ({ type: "document.archived", ...fields }),
  documentFilenameChanged: (
    fields: Omit<z.infer<typeof DocumentFilenameChangedSchema>, "type">,
  ): InstrumentationEvent => ({ type: "document.filename_changed", ...fields }),
  collectionCreated: (
    fields: Omit<z.infer<typeof CollectionCreatedSchema>, "type">,
  ): InstrumentationEvent => ({ type: "collection.created", ...fields }),
  collectionUpdated: (
    fields: Omit<z.infer<typeof CollectionUpdatedSchema>, "type">,
  ): InstrumentationEvent => ({ type: "collection.updated", ...fields }),
  collectionAttached: (
    fields: Omit<z.infer<typeof CollectionAttachedSchema>, "type">,
  ): InstrumentationEvent => ({ type: "collection.attached", ...fields }),
  collectionDetached: (
    fields: Omit<z.infer<typeof CollectionDetachedSchema>, "type">,
  ): InstrumentationEvent => ({ type: "collection.detached", ...fields }),
  collectionReordered: (
    fields: Omit<z.infer<typeof CollectionReorderedSchema>, "type">,
  ): InstrumentationEvent => ({ type: "collection.reordered", ...fields }),
  readFirst: (
    fields: Omit<z.infer<typeof ReadEventSchema>, "type" | "kind">,
  ): InstrumentationEvent => ({ type: "read", kind: "first", ...fields }),
  readAfterEdit: (
    fields: Omit<z.infer<typeof ReadEventSchema>, "type" | "kind">,
  ): InstrumentationEvent => ({ type: "read", kind: "after-edit", ...fields }),
  callerConnected: (
    fields: Omit<z.infer<typeof CallerConnectedSchema>, "type">,
  ): InstrumentationEvent => ({ type: "caller.connected", ...fields }),
  promptAnswered: (
    fields: Omit<z.infer<typeof PromptAnsweredSchema>, "type">,
  ): InstrumentationEvent => ({ type: "prompt.answered", ...fields }),
};

// Derive the idempotency key from the event's natural identity. The
// caller hands this key to EventLogStore.append — a retry of the same
// logical operation collapses to one event because the key collides on
// the unique index. The derivation MUST be deterministic given the
// underlying mutation (no timestamps, no random — those defeat the
// dedup). For events without a natural composite key (caller.connected,
// prompt.answered) the caller provides a salt (e.g. project id).
export function idempotencyKey(
  event: InstrumentationEvent,
  // The ledger row id of the originating mutation, supplied by the write-path
  // (outbox) enqueue. It is this mutation's unique identity, used as the
  // dedup discriminator for events whose natural key is NOT unique per edit:
  // head-only document edits (rename/archive/filename — docVersion does not
  // bump) and collection.updated (no version in the event). Stable across
  // drain retries (the key is stored on the outbox row), so retries still
  // collapse while distinct edits do not. Omitted on the read/emit path,
  // whose events carry their own naturally-unique keys.
  localEventId?: number,
): string {
  switch (event.type) {
    case "document.created":
    case "document.updated":
      return `${event.type}:${event.slug}:v${String(event.docVersion)}`;
    case "document.renamed":
    case "document.archived":
    case "document.filename_changed":
      return localEventId === undefined
        ? `${event.type}:${event.slug}:v${String(event.docVersion)}`
        : `${event.type}:${event.slug}:e${String(localEventId)}`;
    case "collection.created":
      return `${event.type}:${event.collectionSlug}`;
    case "collection.updated":
      return localEventId === undefined
        ? `${event.type}:${event.collectionSlug}`
        : `${event.type}:${event.collectionSlug}:e${String(localEventId)}`;
    case "collection.attached":
    case "collection.detached": {
      // Either documentSlug or folderSlug identifies the member; the
      // disambiguator prefix prevents `collection.attached:c:foo` for
      // doc `foo` from colliding with the same name as a folder.
      const member =
        event.documentSlug !== undefined
          ? `doc:${event.documentSlug}`
          : event.folderSlug !== undefined
            ? `folder:${event.folderSlug}`
            : "unknown";
      return `${event.type}:${event.collectionSlug}:${member}`;
    }
    case "collection.reordered":
      // Reason discriminates: a `drag-reorder` collapses by collection +
      // author (matches the existing change_events behavior); a
      // `delivery-changed` is keyed by member identity so back-to-back
      // flips on different members do not collapse; a
      // `folder-tree-changed` collapses by collection (one fan-out per
      // upstream tree mutation).
      switch (event.reason) {
        case "delivery-changed": {
          const member =
            event.documentSlug !== undefined
              ? `doc:${event.documentSlug}`
              : event.folderSlug !== undefined
                ? `folder:${event.folderSlug}`
                : "unknown";
          return `${event.type}:delivery-changed:${event.collectionSlug}:${member}:${event.delivery ?? ""}`;
        }
        case "folder-tree-changed":
          return `${event.type}:folder-tree-changed:${event.collectionSlug}:${event.changedBy}`;
        case "drag-reorder":
        default:
          return `${event.type}:${event.collectionSlug}:${event.changedBy}`;
      }
    case "read":
      // Both kinds key on (caller, collection, version-set-fingerprint)
      // so a repeat read against the same state collapses to one row
      // BUT a re-emit after a DO restart (cache lost) at a different
      // state does NOT collide with the original `read.first` row —
      // the new state-transition is recorded as a fresh event. The
      // event payload's `kind` preserves the first-vs-after-edit
      // semantic distinction even when both keys share a shape.
      if (event.kind === "first") {
        return `read.first:${event.callerRef}:${event.collectionSlug}:${fingerprintVersionMap(event.versionCapturedAtRead)}`;
      }
      return `read.after-edit:${event.callerRef}:${event.collectionSlug}:${fingerprintVersionMap(event.versionCapturedAtRead)}`;
    case "caller.connected":
      return `caller.connected:${event.callerRef}`;
    case "prompt.answered":
      return `prompt.answered:${event.answeredBy}`;
  }
}

// Stable, deterministic serialization of the captured-versions map so
// the same set always yields the same fingerprint regardless of object
// key order.
function fingerprintVersionMap(map: Readonly<Record<string, number>>): string {
  return Object.keys(map)
    .sort()
    .map((k) => `${k}=${String(map[k] ?? 0)}`)
    .join(",");
}
