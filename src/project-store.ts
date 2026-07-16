import { createStoreWithSchema, type Store } from "@nicia-ai/typegraph";
import { createSqliteBackend } from "@nicia-ai/typegraph/sqlite";
import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import { ledgerMigrations } from "../drizzle-do/migrations";

import type { AssembledCollection } from "./corpus";
import type { LedgerDb } from "./db";
import { ConflictError, isUniqueViolation, RollbackProbe } from "./errors";
import { type CanonicalGraph, canonicalGraph } from "./graph";
import {
  asCollectionSlug,
  asDocumentSlug,
  asFolderSlug,
  type CollectionSlug,
  type DocumentSlug,
  type FolderSlug,
  asProjectId,
  type CallerRef,
  type ProjectId,
} from "./ids";
import {
  type CommandOutcome,
  collectionSnapshotMembers,
  type DomainChange,
  isDocumentChange,
  type ProjectCommandContext,
} from "./project-store/command";
import {
  exportBundleProjection,
  importBundleCommand,
} from "./project-store/commands/bundle";
import {
  attachDocumentCommand,
  attachFolderToCollectionCommand,
  createCollectionCommand,
  detachDocumentCommand,
  detachFolderFromCollectionCommand,
  reorderCollectionDocumentsCommand,
  setFolderLinkDeliveryCommand,
  setMemberDeliveryCommand,
  updateCollectionCommand,
} from "./project-store/commands/collections";
import {
  addCommentCommand,
  type AddCommentInput,
  type CommentThreadView,
  createCommentCommand,
  type CreateCommentInput,
  type CreateCommentResult,
  type DocumentBlocksResult,
  resolveThreadCommand,
  type ResolveThreadInput,
} from "./project-store/commands/comments";
import {
  archiveDocumentsCommand,
  archiveOneDocumentCommand,
  FilenameCollision,
  ImportAbort,
  importDocumentAtPathCommand,
  MarkdownTooLarge,
  renameDocumentCommand,
  renameFilenameCommand,
  saveDocumentCommand,
} from "./project-store/commands/documents";
import {
  createFolderCommand,
  deleteFolderCommand,
  moveFolderCommand,
  placeDocumentInFolderCommand,
  placeDocumentsInFolderCommand,
  renameFolderCommand,
} from "./project-store/commands/folders";
import {
  linkImportedDocumentsCommand,
  linkImportedFolderCommand,
} from "./project-store/commands/import-link";
import { seedExampleCommand } from "./project-store/commands/seed";
import {
  addSuggestionMessageCommand,
  type AddSuggestionMessageInput,
  type AddSuggestionMessageResult,
  applyCreateProposalCommand,
  type ApplyCreateProposalInput,
  type ApplyCreateProposalResult,
  applySuggestionCommand,
  type ApplySuggestionInput,
  type ApplySuggestionResult,
  createDocProposalCommand,
  type CreateDocProposalInput,
  type CreateDocProposalResult,
  createProposalView,
  type CreateProposalView,
  createSuggestionCommand,
  type CreateSuggestionInput,
  type CreateSuggestionResult,
  rejectSuggestionCommand,
  type ProposalResult,
  type RejectSuggestionInput,
  setHunkDecisionCommand,
  type SetHunkDecisionInput,
  type SuggestCreateInput,
  type SuggestionView,
} from "./project-store/commands/suggestions";
import type {
  CollectionOutline,
  CreateInCollectionResult,
  DocumentHistoryEntry,
  DocumentHistoryMeta,
  DocumentSearchHit,
  ImportAndLinkInput,
  ImportAndLinkResult,
  DocumentSnapshot,
  ImportDocResult,
  ImportResult,
  ImportSummary,
  ProjectUsageSnapshot,
  ReapResult,
  RenameDocumentInput,
  RenameFilenameInput,
  RenameFilenameResult,
  SaveDocumentInput,
  SaveResult,
  SeedResult,
  UpdateCollectionInput,
} from "./project-store/contracts";
import { ProjectInstrumentation } from "./project-store/outbox";
import {
  ClientMessage,
  presenceFrom,
  type RealtimeChange,
  SocketAttachment,
  type SocketMeta,
} from "./project-store/presence";
import {
  collectionMembersProjection,
  collectionMetaProjection,
  collectionOutlineProjection,
  collectionStructureProjection,
  documentHistoryProjection,
  documentHistoryPageProjection,
  getDocumentProjection,
  documentHistoryVersionProjection,
  resolvedMembersProjection,
  listCollectionsProjection,
  listDocumentsProjection,
  listDocumentRefsProjection,
  readCollectionProjection,
  resolvedViews,
  searchDocumentsProjection,
  usageSnapshotProjection,
  verifyHistoryProjection,
} from "./project-store/queries";
import { reapExpiredRecords } from "./project-store/retention";
import type { ProjectUnit } from "./project-store/unit";
import {
  BLOCK_PARSER_VERSION,
  parseBlocksWithRanges,
} from "./store/domain/block-parse";
import type { Bundle, BundleSource } from "./store/domain/bundle";
import {
  DEFAULT_COLLECTION_DELIVERY,
  type CollectionDelivery,
} from "./store/domain/collection-expand";
import { chooseImportLinkTarget } from "./store/domain/import-link";
import { events as buildEvent } from "./store/domain/instrumentation-events";
import type { ParsedLink } from "./store/domain/links";
import type { RetentionPolicy } from "./store/domain/retention";
import { deriveSearchText } from "./store/domain/search";
import {
  computeProposalOutcome,
  isCreateProposal,
} from "./store/domain/suggestion";
import type { VerifyResult } from "./store/domain/verify";
import { collectionVersionSnapshot } from "./store/domain/versions";
import type { GraphHandle } from "./store/handle";
import { BlobStore } from "./store/repos/blob-store";
import { BlockMapRepo } from "./store/repos/block-map";
import { ChangeLog, type RecentChange } from "./store/repos/change-log";
import {
  CollectionGraph,
  type CollectionMeta,
} from "./store/repos/collection-graph";
import { CommentRepo } from "./store/repos/comment";
import { DocumentRepo } from "./store/repos/document-repo";
import {
  type DeleteFolderResult,
  FolderRepo,
  type FolderView,
  type MoveFolderResult,
  type PlaceDocumentResult,
  type RenameFolderResult,
} from "./store/repos/folder-repo";
import { InstrumentationOutbox } from "./store/repos/instrumentation-outbox";
import { SuggestionRepo } from "./store/repos/suggestion";
import { VersionRepo } from "./store/repos/version-repo";
import { compact, sha256, slugify } from "./util";

export type {
  CollectionOutline,
  CreateInCollectionResult,
  DocumentHistoryEntry,
  ImportAndLinkInput,
  ImportAndLinkResult,
  ImportCollectionLink,
  ImportDocResult,
  ImportResult,
  ImportSummary,
  ProjectUsageSnapshot,
  ReapResult,
  RenameDocumentInput,
  RenameFilenameInput,
  RenameFilenameResult,
  SaveDocumentInput,
  SaveResult,
  SeedResult,
  UpdateCollectionInput,
} from "./project-store/contracts";

type Unit = ProjectUnit;

// Persistent marker: set once the one-time `searchText` backfill has run for
// this DO, so a reindex never repeats across restarts.
const SEARCH_BACKFILL_KEY = "search:backfilled:v1";
// Documents reindexed per backfill transaction — bounds the work (blob reads
// + node updates) in any single transaction for an unbounded legacy project.
const SEARCH_BACKFILL_BATCH = 100;

// TypeGraph 0.35 widened its built-in traversal indexes so the actual
// traversal SQL is index-only. Its idempotent bootstrap cannot replace an
// existing same-name index with a different column list, so every pre-0.35
// ProjectStore needs this one-time physical migration. Keep the marker in DO
// storage rather than the TypeGraph schema document: this is a database-level
// migration, not a graph-model evolution.
export const TYPEGRAPH_035_EDGE_INDEX_MIGRATION_KEY =
  "typegraph-physical-schema:0.35-edge-covering-indexes";

const TYPEGRAPH_035_EDGE_INDEX_STATEMENTS = [
  "DROP INDEX IF EXISTS typegraph_edges_from_idx",
  `CREATE INDEX typegraph_edges_from_idx ON typegraph_edges
    (graph_id, from_kind, from_id, kind, to_kind, deleted_at, valid_from, valid_to, to_id)`,
  "DROP INDEX IF EXISTS typegraph_edges_to_idx",
  `CREATE INDEX typegraph_edges_to_idx ON typegraph_edges
    (graph_id, to_kind, to_id, kind, from_kind, deleted_at, valid_from, valid_to, from_id)`,
] as const;

// Maps a committed command's outcome to the real-time change to broadcast,
// or undefined to fall back to the domain-derived change. Always a function
// so the broadcast can be conditioned on whether the command actually
// succeeded (a returned `{ ok: false }` must not broadcast a phantom event).
type RealtimeChangeResolver<T> = (
  outcome: CommandOutcome<T>,
) => RealtimeChange | undefined;

export type DocumentReviewSnapshot = Readonly<{
  doc: DocumentSnapshot | undefined;
  blocks: DocumentBlocksResult;
  comments: readonly CommentThreadView[];
  suggestions: readonly SuggestionView[];
}>;

export type DocumentHistoryPageSnapshot = Readonly<{
  doc: DocumentSnapshot | undefined;
  history: readonly DocumentHistoryMeta[];
  active: DocumentHistoryEntry | undefined;
}>;

// Internal sentinel: a scoped create's bound collection vanished between
// scope resolution and the create transaction, so the attach failed.
// Thrown to roll the create back (never leave a document created but
// unattached — outside its own caller's scope) and map to a fail-closed
// 403, matching the collection-gone path in `apiKeyScope`.
class CollectionUnavailable extends Error {
  constructor() {
    super("collection unavailable");
    this.name = "CollectionUnavailable";
  }
}

// The single, deliberate unsafe cast in the system. TypeGraph 0.26 and the
// Drizzle ledger ride the SAME do-sqlite handle (storage handle or the
// in-transaction tx.sql); the structural mismatch with LedgerDb is
// unavoidable and is contained to exactly this function.
function asLedgerDb(handle: unknown): LedgerDb {
  return handle as LedgerDb;
}

// WebSocket.OPEN — the readyState of a live socket.
const WS_OPEN = 1;

// Stable, deterministic serialization of a {slug: docVersion} map so
// two reads with the same version-set produce the same fingerprint
// regardless of object key order. Algorithm is fixed (sort keys, join
// `${k}=${v}` with comma) so it agrees byte-for-byte with the matching
// fingerprint inside `idempotencyKey()` for read events.
function fingerprintVersions(map: Readonly<Record<string, number>>): string {
  return Object.keys(map)
    .sort()
    .map((k) => `${k}=${String(map[k] ?? 0)}`)
    .join(",");
}

function realtimeChangeFromDomain(
  changes: readonly DomainChange[],
): RealtimeChange | undefined {
  // Prefer the document change when a command emits several (archiving a doc
  // that's in collections emits detach/reorder changes first, then the
  // document.archived — the document one is what a viewer needs to hear).
  const change = changes.find(isDocumentChange) ?? changes[0];
  if (change === undefined) return undefined;
  if (isDocumentChange(change)) {
    return compact({
      area: "document" as const,
      action: change.kind,
      actorId: change.changedBy,
      docSlug: change.slug,
      docVersion: change.docVersion,
      title: change.title,
    });
  }
  return compact({
    area: "collection" as const,
    action: change.kind,
    actorId: change.changedBy,
    collectionSlug: change.collectionSlug,
    docSlug: change.documentSlug,
  });
}

// One ProjectStore instance per Project. TypeGraph (Document/
// DocumentVersion/Collection/CollectionVersion/edges) and the Drizzle
// content/event ledger share this DO's SQLite, so every mutation is one
// atomic ctx.storage.transaction (TypeGraph 0.26 do-sqlite). This class
// orchestrates; persistence lives in store/repos, pure rules in
// store/domain. The durable instrumentation event stream lives in a
// sibling per-Project EventLogStore DO (own storage budget); save
// write commands append local change_events + an instrumentation_outbox row
// atomically with the underlying mutation, then drain that outbox to the
// sibling per-Project EventLogStore after commit. The EventLogStore gives the
// audit stream a queryable source of truth without splitting the save tx.
export class ProjectStore extends DurableObject<Env> {
  private store: Store<CanonicalGraph> | undefined;
  private initPromise: Promise<Store<CanonicalGraph>> | undefined;
  // The DO's storage is stable for its lifetime, so the read-side ledger
  // handle is built once (writes use the tx-scoped handle).
  private ledger: LedgerDb | undefined;
  // The content-keyed link lens: a document's relative-link set is a
  // pure function of its immutable bytes, so it is parsed once per
  // contentHash and never invalidated (content never mutates).
  private readonly parsedLinksByHash = new Map<string, readonly ParsedLink[]>();
  // Per-(callerRef, collectionSlug) version-fingerprint cache. A
  // routine repeat poll with no intervening edit produces the same
  // fingerprint as the prior cached read, so the cross-DO append is
  // skipped entirely. The cache is ephemeral (DO restart loses it);
  // a re-emit after restart collapses at the EventLogStore via the
  // unique idempotency_key, so the projection never double-counts.
  // Bounded by the active set of callers × collections.
  private readonly readDedupCache = new Map<string, string>();
  private instrumentationOutbox: ProjectInstrumentation | undefined;
  // Cleared until the one-time `searchText` backfill has run for this DO
  // (see `ensureSearchBackfilled`); mirrors a persistent storage marker so
  // the reindex happens at most once per DO, not once per instance.
  private searchBackfilled = false;

  private ledgerDb(): LedgerDb {
    return (this.ledger ??= asLedgerDb(drizzle(this.ctx.storage)));
  }

  // The Project id this DO instance is addressed by — recovered from
  // `idFromName(projectId)` at the multi-tenant boundary (`storeFor`).
  // Empty string is the never-named DO case (tests that fetch a DO by
  // raw id rather than by name).
  private projectId(): ProjectId {
    return asProjectId(this.ctx.id.name ?? "");
  }

  private instrumentation(): ProjectInstrumentation {
    return (this.instrumentationOutbox ??= new ProjectInstrumentation({
      env: this.env,
      projectId: () => this.projectId(),
      read: () => this.read(),
      write: (fn) => this.write(fn),
      scheduleAlarm: () => this.ctx.storage.setAlarm(Date.now() + 30_000),
    }));
  }

  private commandContext(u: Unit, now: string): ProjectCommandContext {
    return {
      u,
      now,
      hash: sha256,
      collection: {
        resolvedViews,
        snapshot: (unit, slug, changedBy, changedAt) =>
          this.snapshotCollection(unit, slug, changedBy, changedAt),
      },
    };
  }

  private async writeCommand<T>(
    now: string,
    fn: (ctx: ProjectCommandContext) => Promise<CommandOutcome<T>>,
    realtime?: RealtimeChangeResolver<T>,
  ): Promise<CommandOutcome<T>> {
    const outcome = await this.write(async (u) => {
      const out = await fn(this.commandContext(u, now));
      await this.instrumentation().recordChanges(u, out.changes);
      if (out.rollbackAfterRecord === true) throw new RollbackProbe();
      return out;
    });
    await this.instrumentation().drain();
    // Nudge connected clients that something in this project changed so they
    // re-fetch (comments / suggestions / the document). Ephemeral, best-effort.
    this.broadcastChanged(
      realtime?.(outcome) ?? realtimeChangeFromDomain(outcome.changes),
    );
    return outcome;
  }

  override async alarm(): Promise<void> {
    await this.instrumentation().drain();
  }

  // — Real-time channel (presence + change nudges) ————————————————————
  // The one sanctioned WebSocket surface. Hibernation-aware: per-socket
  // metadata is serialized so the DO can sleep between messages. Identity
  // (uid / name) and authorization are resolved by the Worker BEFORE the
  // upgrade is forwarded here, then passed as query params.

  override fetch(request: Request): Response {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const meta: SocketMeta = {
      userId: url.searchParams.get("uid") ?? "",
      userName: url.searchParams.get("name") ?? "Someone",
      docSlug: url.searchParams.get("doc"),
    };
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(meta);
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(
    ws: WebSocket,
    message: ArrayBuffer | string,
  ): void {
    if (typeof message !== "string") return;
    let data: unknown;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    const parsed = ClientMessage.safeParse(data);
    if (!parsed.success) return;
    const current = SocketAttachment.safeParse(ws.deserializeAttachment());
    const base: SocketMeta = current.success
      ? current.data
      : { userId: "", userName: "Someone", docSlug: null };
    ws.serializeAttachment({ ...base, docSlug: parsed.data.docSlug });
    this.broadcastPresence();
  }

  override webSocketClose(): void {
    this.broadcastPresence();
  }

  override webSocketError(): void {
    this.broadcastPresence();
  }

  private broadcastPresence(): void {
    const metas: SocketMeta[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const m = SocketAttachment.safeParse(ws.deserializeAttachment());
      if (m.success) metas.push(m.data);
    }
    this.broadcast({ type: "presence", users: presenceFrom(metas) });
  }

  private broadcastChanged(change?: RealtimeChange): void {
    this.broadcast({
      type: "changed",
      ...(change === undefined
        ? {}
        : { change: this.withPresenceActorName(change) }),
    });
  }

  private broadcast(message: unknown): void {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WS_OPEN) continue;
      try {
        ws.send(text);
      } catch {
        continue;
      }
    }
  }

  private withPresenceActorName(change: RealtimeChange): RealtimeChange {
    // mcp/cli actors are agents/scripts with no presence socket — scanning
    // every socket would never match, so skip the work; the name already set,
    // or no actor, also short-circuits.
    if (
      change.actorName !== undefined ||
      change.actorId === undefined ||
      change.channel === "mcp" ||
      change.channel === "cli"
    ) {
      return change;
    }
    for (const ws of this.ctx.getWebSockets()) {
      const m = SocketAttachment.safeParse(ws.deserializeAttachment());
      if (m.success && m.data.userId === change.actorId) {
        return { ...change, actorName: m.data.userName };
      }
    }
    return change;
  }

  // — Read-path event emission ————————————————————————————————————————

  // Record an MCP read for the freshness moment. The scoped executor
  // hands us the CallerRef, the bound collectionSlug, and the
  // version-set the read actually saw. We emit at most ONE event per
  // state change:
  //   * first time this caller reads this collection → `read.first`
  //   * subsequent read whose captured-version-set differs from the
  //     prior cached fingerprint → `read.after-edit`
  //   * subsequent read with the same fingerprint → no event
  // Failures are logged and swallowed — same posture as save events.
  async recordRead(
    callerRef: CallerRef,
    collectionSlug: string,
    versionCapturedAtRead: Readonly<Record<string, number>>,
  ): Promise<void> {
    const cacheKey = `${callerRef}|${collectionSlug}`;
    const fingerprint = fingerprintVersions(versionCapturedAtRead);
    const prior = this.readDedupCache.get(cacheKey);
    if (prior === fingerprint) return;
    const event =
      prior === undefined
        ? buildEvent.readFirst({
            callerRef,
            collectionSlug,
            versionCapturedAtRead,
          })
        : buildEvent.readAfterEdit({
            callerRef,
            collectionSlug,
            versionCapturedAtRead,
          });
    // Emit BEFORE updating the cache. If emit transiently fails the
    // cache stays at the prior fingerprint, so a subsequent poll
    // retries; setting the cache first poisons it forever for the
    // duration of this DO's lifetime. The append's
    // `onConflictDoNothing` idempotency-key check makes a successful
    // re-attempt collapse to the same monotonic id.
    const emitted = await this.instrumentation().emit(event);
    if (emitted) this.readDedupCache.set(cacheKey, fingerprint);
  }

  // Emitted once per `respondMcp` from the request edge — at most one
  // network call per request per CallerRef. The EventLogStore's
  // idempotency_key (`caller.connected:<callerRef>`) collapses every
  // subsequent connect of the same caller to the original monotonic
  // id, so the projection's "second distinct caller connected" signal
  // latches exactly once.
  async recordCallerConnected(callerRef: CallerRef): Promise<void> {
    await this.instrumentation().emit(
      buildEvent.callerConnected({ callerRef }),
    );
  }

  // Lazy, idempotent init. The ledger schema (content_blobs,
  // change_events) is applied by the Drizzle DO migrator from the
  // generated bundle — drizzle-kit is the single source of this DDL
  // (src/db.ts → `pnpm db:generate:do`). The migrator runs DDL in its
  // own DO transaction, BEFORE TypeGraph init, so it never touches a
  // TypeGraph enlisted transaction. TypeGraph then bootstraps its own
  // node/edge tables.
  private async ensureStore(): Promise<Store<CanonicalGraph>> {
    if (this.store) return this.store;
    this.initPromise ??= (async () => {
      await migrate(this.ledgerDb(), ledgerMigrations);
      const backend = createSqliteBackend(drizzle(this.ctx.storage));
      const [store] = await createStoreWithSchema(canonicalGraph, backend);
      await this.migrateTypeGraph035PhysicalSchema();
      const materialized = await store.materializeIndexes({
        stopOnError: true,
        // Cloudflare Durable Object SQLite rejects TypeGraph's
        // `PRAGMA analysis_limit` statistics-refresh prelude with
        // SQLITE_AUTH. These equality-prefix indexes do not depend on
        // skip-scan statistics, so materialize them without the unsupported
        // maintenance verb.
        refreshStatistics: false,
      });
      const incomplete = materialized.results.find(
        (result) =>
          result.status !== "created" &&
          result.status !== "alreadyMaterialized",
      );
      if (incomplete !== undefined) {
        throw (
          incomplete.error ??
          new Error(
            `TypeGraph index ${incomplete.indexName} was not materialized: ${incomplete.reason ?? incomplete.status}`,
          )
        );
      }
      this.store = store;
      return store;
    })();
    return this.initPromise;
  }

  private async migrateTypeGraph035PhysicalSchema(): Promise<void> {
    if (
      await this.ctx.storage.get<boolean>(
        TYPEGRAPH_035_EDGE_INDEX_MIGRATION_KEY,
      )
    ) {
      return;
    }
    // `sql.exec` is synchronous inside one DO turn. The marker is written only
    // after both indexes exist; an interrupted migration safely retries the
    // idempotent drop/create sequence on the next activation.
    for (const statement of TYPEGRAPH_035_EDGE_INDEX_STATEMENTS) {
      this.ctx.storage.sql.exec(statement);
    }
    await this.ctx.storage.put(TYPEGRAPH_035_EDGE_INDEX_MIGRATION_KEY, true);
  }

  private unit(graph: GraphHandle, ledger: LedgerDb): Unit {
    return {
      docs: new DocumentRepo(graph),
      cols: new CollectionGraph(graph),
      folders: new FolderRepo(graph),
      log: new ChangeLog(ledger),
      blobs: new BlobStore(ledger),
      versions: new VersionRepo(graph),
      outbox: new InstrumentationOutbox(ledger),
      blockMaps: new BlockMapRepo(ledger),
      comments: new CommentRepo(ledger),
      suggestions: new SuggestionRepo(ledger),
    };
  }

  // The only place a transaction opens.
  private async write<T>(fn: (u: Unit) => Promise<T>): Promise<T> {
    const store = await this.ensureStore();
    return store.transaction((tx) => fn(this.unit(tx, asLedgerDb(tx.sql))));
  }

  // Non-transactional unit for reads — same repo API, storage handle.
  private async read(): Promise<Unit> {
    const store = await this.ensureStore();
    return this.unit(store, this.ledgerDb());
  }

  // Tear down all of this project's data (reconcile sweep, after a
  // project soft-delete). Idempotent.
  async purge(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.store = undefined;
    this.initPromise = undefined;
    this.ledger = undefined;
  }

  // — Reads ——————————————————————————————————————————————————————————

  async getDocument(slug: DocumentSlug): Promise<DocumentSnapshot | undefined> {
    return getDocumentProjection(await this.read(), slug);
  }

  async documentReviewSnapshot(
    slug: DocumentSlug,
  ): Promise<DocumentReviewSnapshot> {
    const u = await this.read();
    const doc = await getDocumentProjection(u, slug);
    if (doc === undefined) {
      return {
        doc: undefined,
        blocks: { found: false },
        comments: [],
        suggestions: [],
      };
    }
    const [blocks, comments, suggestions] = await Promise.all([
      this.documentBlocksForHead(u, slug, doc.docVersion, doc.markdown),
      this.commentThreadViews(u, slug),
      this.suggestionViews(u, slug),
    ]);
    return { doc, blocks, comments, suggestions };
  }

  async documentHistoryPageSnapshot(
    slug: DocumentSlug,
    selectedVersion?: number,
  ): Promise<DocumentHistoryPageSnapshot> {
    const u = await this.read();
    const [doc, page] = await Promise.all([
      getDocumentProjection(u, slug),
      documentHistoryPageProjection(u, slug, selectedVersion),
    ]);
    return { doc, ...page };
  }

  async documentHistoryVersion(
    slug: DocumentSlug,
    docVersion: number,
  ): Promise<DocumentHistoryEntry | undefined> {
    return documentHistoryVersionProjection(
      await this.read(),
      slug,
      docVersion,
    );
  }

  async listDocuments(): Promise<
    readonly {
      slug: string;
      title: string;
      docVersion: number;
      size: number;
      filename: string;
      path: string;
      folderSlug: string | null;
      updatedAt: string;
    }[]
  > {
    return listDocumentsProjection(await this.read());
  }

  async listDocumentRefs(): Promise<{ slug: string; path: string }[]> {
    return listDocumentRefsProjection(await this.read());
  }

  async searchDocuments(query: string): Promise<readonly DocumentSearchHit[]> {
    await this.ensureSearchBackfilled();
    const store = await this.ensureStore();
    return searchDocumentsProjection(
      store,
      this.unit(store, this.ledgerDb()),
      query,
    );
  }

  // Populate `searchText` for live documents written before the field
  // existed (pre-FTS DOs); new and edited documents index on write. Runs in
  // bounded batches, one write transaction each, so an unlimited legacy
  // project can't blow a single transaction's CPU/subrequest budget. No
  // cursor is needed: each `setSearchText` clears the row from the work
  // queue, so a crashed or oversized run resumes from what's left rather
  // than restarting. TypeGraph upserts each node's FTS row on the write, so
  // no separate `rebuildFulltext` pass is required. Returns the number of
  // documents (re)indexed.
  async reindexSearchText(): Promise<number> {
    let total = 0;
    for (;;) {
      const batch = await this.write(async (u) => {
        const docs = await u.docs.unindexed(SEARCH_BACKFILL_BATCH);
        for (const d of docs) {
          const body = (await u.blobs.get(d.contentHash)) ?? "";
          await u.docs.setSearchText(d, deriveSearchText(d.title, body));
        }
        return docs.length;
      });
      total += batch;
      if (batch < SEARCH_BACKFILL_BATCH) break;
    }
    return total;
  }

  private async ensureSearchBackfilled(): Promise<void> {
    if (this.searchBackfilled) return;
    if (await this.ctx.storage.get<boolean>(SEARCH_BACKFILL_KEY)) {
      this.searchBackfilled = true;
      return;
    }
    await this.reindexSearchText();
    await this.ctx.storage.put(SEARCH_BACKFILL_KEY, true);
    this.searchBackfilled = true;
  }

  async listCollections(): Promise<readonly CollectionMeta[]> {
    return listCollectionsProjection(await this.read());
  }

  async usageSnapshot(): Promise<ProjectUsageSnapshot> {
    return usageSnapshotProjection(await this.read());
  }

  // Single-collection head-node lookup — for callers that need
  // name/description/budget but not the resolved member structure (e.g.
  // the MCP setup page's prompt template). One DO read, no folder
  // subtree walk, no blob hydration.
  async collectionMeta(collectionSlug: CollectionSlug): Promise<
    | { found: false }
    | {
        found: true;
        name: string;
        description?: string;
        alwaysIncludeBudgetTokens: number;
      }
  > {
    return collectionMetaProjection(await this.read(), collectionSlug);
  }

  async readCollection(collectionSlug: CollectionSlug): Promise<
    | { found: false }
    | ({
        found: true;
        name: string;
        description?: string;
      } & AssembledCollection)
  > {
    return readCollectionProjection(await this.read(), collectionSlug);
  }

  // The resolved member slug set of a collection (direct + folder-
  // expanded), for the MCP soft relevance scope: `list_documents` /
  // `read_document` filter to this set when an agent declares the
  // collection it is working in. Shares `resolvedViews` with
  // `readCollection` so the scope cannot disagree with what would be
  // assembled, but skips blob hydration + corpus assembly — the scope
  // check needs only slugs. `undefined` = no such collection.
  async collectionMembers(
    collectionSlug: CollectionSlug,
  ): Promise<readonly string[] | undefined> {
    return collectionMembersProjection(await this.read(), collectionSlug);
  }

  // The collection-builder view: the resolved member order plus
  // *provenance* — which members are there via a direct `includes`
  // edge (individually detachable / reorderable) vs pulled in by a
  // linked folder (the folder is the unit; the doc is read-only here).
  // Separate from `readCollection` so the MCP / bundle paths (which
  // route through `resolvedViews` directly) are untouched.
  async collectionStructure(collectionSlug: CollectionSlug): Promise<
    | { found: false }
    | {
        found: true;
        name: string;
        description?: string;
        alwaysIncludeBudgetTokens: number;
        folders: readonly Readonly<{
          slug: string;
          name: string;
          position: number;
          delivery: CollectionDelivery;
        }>[];
        members: readonly Readonly<{
          slug: string;
          title: string;
          docVersion: number;
          size: number;
          updatedAt: string;
          direct: boolean;
          position: number;
          delivery: CollectionDelivery;
          viaFolder?: string;
        }>[];
      }
  > {
    return collectionStructureProjection(await this.read(), collectionSlug);
  }

  // Flat edge list (collection → document, with position) for the
  // whole project — the project-graph data source. Deliberately lean:
  // reuses `cols.ordered` (Document heads only) and never resolves
  // blob bytes, so it stays cheap even though `readCollection` (which
  // assembles full corpus text) shares the same accessor.
  // Resolved (collection, document) membership for every collection —
  // direct + folder-expanded, deduped. Backs all document/collection
  // count surfaces so a linked folder's docs are counted everywhere.
  async listResolvedMembers(): Promise<
    readonly Readonly<{ collectionSlug: string; documentSlug: string }>[]
  > {
    return resolvedMembersProjection(await this.read());
  }

  async recentChanges(limit: number): Promise<readonly RecentChange[]> {
    return (await this.read()).log.recent(limit);
  }

  async lastEventId(): Promise<number> {
    return (await this.read()).log.lastEventId();
  }

  async versionCount(slug: DocumentSlug): Promise<number> {
    return (await this.read()).versions.versionCount(slug);
  }

  // The DocumentVersion chain for one document, newest first, each
  // version's body resolved from the content store. A version whose blob
  // was reaped by retention still appears (lineage is the version nodes,
  // not the blobs) with retained:false and empty markdown — the UI shows
  // a placeholder and cannot diff it.
  async documentHistory(
    slug: DocumentSlug,
  ): Promise<readonly DocumentHistoryEntry[]> {
    return documentHistoryProjection(await this.read(), slug);
  }

  // Walk the content-addressed chain (whole project, or one document)
  // and re-derive every invariant it promises. Reuses the same pure
  // verifier the MCP tool and CLI surface.
  async verifyHistory(slug?: DocumentSlug): Promise<VerifyResult> {
    return verifyHistoryProjection(await this.read(), slug);
  }

  // — Retention ——————————————————————————————————————————————————————

  // Reap records past the Project's retention window. One atomic tx so
  // the version-node, edge, change-event, and blob deletions cannot tear.
  // Heads and versions still pinned by a live CollectionVersion are never
  // reaped, so `getDocument` and `verifyHistory` stay green afterwards.
  // Blobs go only when no surviving Document/DocumentVersion references
  // the hash. An absent window = "forever" (that pass is skipped).
  // `nowMs` is a test-only clock seam (mirrors `__failAfterWrites`);
  // production uses the wall clock.
  async reapExpired(
    retention: RetentionPolicy,
    nowMs?: number,
  ): Promise<ReapResult> {
    const now = nowMs ?? Date.now();
    return this.write((u) => reapExpiredRecords(u, retention, now));
  }

  // — Bundle export / import ————————————————————————————————————————

  // Serialize the whole Project to the portable bundle contract.
  // Deterministic ordering everywhere so export → import → export is
  // byte-identical (the alignment test).
  async exportBundle(source: BundleSource): Promise<Bundle> {
    const u = await this.read();
    return exportBundleProjection(u, source, resolvedViews);
  }

  // Rebuild a Project from a bundle in one atomic tx. The root hash is
  // recomputed and must match (tamper / drift rejection) before any
  // write. Dependency order: blobs → document head → its version chain
  // (the `versions_of` edge needs the head node) → collections
  // (`includes` edges + the `CollectionVersion` snapshot, members
  // pinned verbatim).
  async importBundle(bundle: Bundle): Promise<ImportResult> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      importBundleCommand(ctx, bundle),
    );
    return outcome.result;
  }

  // — Writes ————————————————————————————————————————————————————————

  // The 409 / rollback / racing-duplicate taxonomy → structured result.
  private async saveError(
    err: unknown,
    input: SaveDocumentInput,
  ): Promise<SaveResult> {
    if (err instanceof RollbackProbe) return { ok: false, rolledBack: true };
    if (err instanceof FilenameCollision) {
      return { ok: false, segmentCollision: true };
    }
    if (err instanceof MarkdownTooLarge) {
      return { ok: false, tooLarge: true };
    }
    if (err instanceof ConflictError) {
      return { ok: false, conflict: true, currentVersion: err.currentVersion };
    }
    // A racing N+1: both saves create `DocumentVersion (slug, N+1)`; the
    // loser hits the node-unique constraint (TypeGraph UniquenessError) and
    // its whole enlisted tx rolls back. Confirm it really was a version race
    // — the head advanced past the client's base — before reporting a 409.
    // A UniquenessError on any OTHER constraint (e.g. a Document-slug create
    // collision) with the head unchanged is a real fault, not a conflict, and
    // must surface rather than be disguised as "someone else edited this".
    if (isUniqueViolation(err)) {
      const head = await this.getDocument(input.slug);
      if (head !== undefined && head.docVersion > input.clientVersion) {
        return { ok: false, conflict: true, currentVersion: head.docVersion };
      }
    }
    throw err;
  }

  async saveDocument(input: SaveDocumentInput): Promise<SaveResult> {
    const now = new Date().toISOString();
    try {
      const outcome = await this.writeCommand(now, (ctx) =>
        saveDocumentCommand(ctx, input),
      );
      return { ok: true, docVersion: outcome.result.docVersion };
    } catch (err) {
      return this.saveError(err, input);
    }
  }

  // Create a NEW document into `collectionSlug` in a single transaction —
  // the collection-scoped REST surface's create path, entered when the
  // transport's (necessarily stale) member snapshot didn't list the slug.
  // The whole decision is re-made inside the write, so it is race-correct:
  //
  //   - slug already exists AND is in the bound collection → another
  //     client won a concurrent create; the caller IS authorized, so
  //     delegate to the normal save and let `clientVersion` decide (a
  //     stale version yields a retryable 409, never a misleading 403).
  //   - slug exists but is NOT in the bound collection → genuinely another
  //     scope's document → `forbidden` (403).
  //   - slug is new → create + attach together; "created" must mean
  //     "created AND attached", so if the bound collection vanished under
  //     us the attach fails and the whole unit rolls back (fail-closed
  //     403) rather than orphaning the document outside its own scope.
  async createDocumentInCollection(
    input: SaveDocumentInput,
    collectionSlug: CollectionSlug,
    position: number,
  ): Promise<CreateInCollectionResult> {
    const now = new Date().toISOString();
    try {
      const outcome = await this.writeCommand<
        { forbidden: true } | { docVersion: number }
      >(now, async (ctx) => {
        const head = await ctx.u.docs.find(input.slug);
        if (head !== undefined) {
          const members = await collectionMembersProjection(
            ctx.u,
            collectionSlug,
          );
          if (members?.includes(input.slug) !== true) {
            return { result: { forbidden: true }, changes: [] };
          }
          // Already a member → a plain update; clientVersion guards it.
          const saved = await saveDocumentCommand(ctx, input);
          return {
            result: { docVersion: saved.result.docVersion },
            changes: saved.changes,
          };
        }
        const saved = await saveDocumentCommand(ctx, input);
        // "reference", never the "core" default: only a curator opts a
        // member into the always-include payload, matching the web UI's
        // attach — an agent push must not grow every read_collection.
        const attached = await attachDocumentCommand(ctx, {
          collectionSlug,
          documentSlug: input.slug,
          position,
          delivery: "reference",
          changedBy: input.changedBy,
        });
        if (!attached.result.ok) throw new CollectionUnavailable();
        return {
          result: { docVersion: saved.result.docVersion },
          changes: [...saved.changes, ...attached.changes],
        };
      });
      return "forbidden" in outcome.result
        ? { ok: false, forbidden: true }
        : { ok: true, docVersion: outcome.result.docVersion };
    } catch (err) {
      if (err instanceof CollectionUnavailable) {
        return { ok: false, forbidden: true };
      }
      return this.saveError(err, input);
    }
  }

  // — Comments (anchored review layer; off-bundle, off-MCP) ——————————

  // The head version's blocks, addressed by index, for selecting a comment
  // target in the editor. A pure read — the block map is bootstrapped when
  // a comment is actually created.
  async getDocumentBlocks(slug: DocumentSlug): Promise<DocumentBlocksResult> {
    const u = await this.read();
    const head = await u.docs.find(slug);
    if (head === undefined || head.archivedAt !== undefined) {
      return { found: false };
    }
    const markdown = (await u.blobs.get(head.contentHash)) ?? "";
    return this.documentBlocksForHead(u, slug, head.docVersion, markdown);
  }

  private async documentBlocksForHead(
    u: Unit,
    slug: DocumentSlug,
    docVersion: number,
    markdown: string,
  ): Promise<DocumentBlocksResult> {
    const parsed = parseBlocksWithRanges(markdown);
    const stored = await u.blockMaps.headMap(slug);
    const mapped =
      stored?.docVersion === docVersion &&
      stored.parserVersion === BLOCK_PARSER_VERSION &&
      stored.blocks.length === parsed.length &&
      stored.blocks.every((b, i) => b.kind === parsed[i]?.kind)
        ? stored.blocks
        : undefined;
    return {
      found: true,
      docVersion,
      blocks: parsed.map((b, i) =>
        compact({
          id: mapped?.[i]?.id,
          index: i,
          kind: b.kind,
          text: b.text,
          sourceStart: b.sourceStart,
          sourceEnd: b.sourceEnd,
        }),
      ),
    };
  }

  async listComments(
    slug: DocumentSlug,
  ): Promise<readonly CommentThreadView[]> {
    return this.commentThreadViews(await this.read(), slug);
  }

  private async commentThreadViews(
    u: Unit,
    slug: DocumentSlug,
  ): Promise<readonly CommentThreadView[]> {
    const threads = await u.comments.threadsForDoc(slug);
    const comments = await u.comments.commentsForThreads(
      threads.map((t) => t.id),
    );
    return threads.map((t) => ({
      id: t.id,
      status: t.status,
      anchorBlockId: t.anchorBlockId,
      anchorStart: t.anchorStart,
      anchorEnd: t.anchorEnd,
      quote: {
        prefix: t.quotePrefix,
        exact: t.quoteExact,
        suffix: t.quoteSuffix,
      },
      createdBy: t.createdBy,
      createdAt: t.createdAt,
      resolvedBy: t.resolvedBy ?? undefined,
      resolvedAt: t.resolvedAt ?? undefined,
      comments: comments
        .filter((c) => c.threadId === t.id)
        .map((c) => ({
          id: c.id,
          body: c.body,
          createdBy: c.createdBy,
          createdAt: c.createdAt,
        })),
    }));
  }

  async createComment(input: CreateCommentInput): Promise<CreateCommentResult> {
    const now = new Date().toISOString();
    try {
      const outcome = await this.writeCommand(
        now,
        (ctx) => createCommentCommand(ctx, input),
        (out) =>
          out.result.ok
            ? {
                area: "review",
                action: "comment.created",
                actorId: input.createdBy,
                docSlug: input.slug,
              }
            : undefined,
      );
      return outcome.result;
    } catch (err) {
      if (err instanceof ConflictError) {
        return {
          ok: false,
          reason: "conflict",
          currentVersion: err.currentVersion,
        };
      }
      throw err;
    }
  }

  async addComment(
    input: AddCommentInput,
  ): Promise<Readonly<{ commentId: number }>> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(
      now,
      (ctx) => addCommentCommand(ctx, input),
      (out) =>
        out.result.documentSlug === undefined
          ? undefined
          : {
              area: "review",
              action: "comment.replied",
              actorId: input.createdBy,
              docSlug: out.result.documentSlug,
            },
    );
    return { commentId: outcome.result.commentId };
  }

  async resolveCommentThread(
    input: ResolveThreadInput,
  ): Promise<Readonly<{ ok: true }>> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(
      now,
      (ctx) => resolveThreadCommand(ctx, input),
      (out) =>
        out.result.documentSlug === undefined
          ? undefined
          : {
              area: "review",
              action: "comment.resolved",
              actorId: input.resolvedBy,
              docSlug: out.result.documentSlug,
            },
    );
    return { ok: outcome.result.ok };
  }

  // — Suggestions (per-hunk proposed edits) ——————————————————————————

  async createSuggestion(
    input: CreateSuggestionInput,
  ): Promise<CreateSuggestionResult> {
    const now = new Date().toISOString();
    try {
      const outcome = await this.writeCommand(
        now,
        (ctx) => createSuggestionCommand(ctx, input),
        (out) =>
          out.result.ok
            ? {
                area: "review",
                action: "suggestion.created",
                actorId: input.createdBy,
                docSlug: input.slug,
                channel: input.channel ?? "web",
              }
            : undefined,
      );
      return outcome.result;
    } catch (err) {
      if (err instanceof ConflictError) {
        return {
          ok: false,
          reason: "conflict",
          currentVersion: err.currentVersion,
        };
      }
      throw err;
    }
  }

  // The MCP write path (agent-as-suggester). The scoped executor has
  // already membership-gated `slug` to the caller's bound Collection and
  // passes the resolved `callerRef` as the author — the agent proposes,
  // only a human accepts. Delegates to createSuggestion so the
  // ConflictError→409 mapping, the write transaction, and the post-commit
  // change broadcast are shared with the web path (no parallel write).
  async suggestEdit(
    callerRef: CallerRef,
    slug: DocumentSlug,
    proposedMarkdown: string,
    baseDocVersion: number,
  ): Promise<CreateSuggestionResult> {
    return this.createSuggestion({
      slug,
      proposedMarkdown,
      clientVersion: baseDocVersion,
      createdBy: callerRef,
      // Correct by construction: this DO method IS the MCP-transport suggest
      // entry (only the scoped MCP executor reaches it). A future non-MCP
      // suggest path must NOT reuse this method — give it its own entry (or
      // thread the channel through the port) so it labels truthfully rather
      // than inheriting "mcp".
      channel: "mcp",
    });
  }

  // Generic create-proposal entry (channel supplied by the caller); the
  // MCP transport goes through suggestCreate below, which labels itself.
  async createDocProposal(
    input: CreateDocProposalInput,
  ): Promise<CreateDocProposalResult> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(
      now,
      (ctx) => createDocProposalCommand(ctx, input),
      (out) =>
        out.result.ok
          ? {
              area: "review",
              action: "suggestion.created",
              actorId: input.createdBy,
              docSlug: asDocumentSlug(out.result.slug),
              channel: input.channel ?? "web",
            }
          : undefined,
    );
    return outcome.result;
  }

  // The MCP create-proposal path (agent proposes a NEW document). Only the
  // scoped executor reaches this method, and it overwrites
  // `originCollectionSlug` with its bound Collection before the call — so a
  // human apply attaches the created document back where the agent works.
  // Same channel discipline as suggestEdit: this method IS the MCP entry.
  async suggestCreate(
    callerRef: CallerRef,
    input: SuggestCreateInput,
  ): Promise<CreateDocProposalResult> {
    return this.createDocProposal(
      compact({
        slug: input.slug,
        path: input.path,
        originCollectionSlug: input.originCollectionSlug,
        proposedMarkdown: input.proposedMarkdown,
        createdBy: callerRef,
        channel: "mcp" as const,
      }),
    );
  }

  // Caller-scoped proposal result for MCP. Ownership is checked again in
  // the DO (in addition to scopedExecutor's closure-bound identity) so a
  // guessed id never reveals another caller's review state.
  async proposalResult(
    callerRef: CallerRef,
    proposalId: number,
  ): Promise<ProposalResult> {
    const u = await this.read();
    const proposal = await u.suggestions.get(proposalId);
    if (proposal?.createdBy !== callerRef) {
      return { found: false };
    }
    const [hunks, messages] = await Promise.all([
      u.suggestions.hunksFor(proposal.id),
      u.suggestions.messagesForSuggestions([proposal.id]),
    ]);
    // These are the hunks applied to the resulting document, not provisional
    // marks on a still-open review. Keep them empty until application commits.
    const acceptedHunks = hunks
      .filter((h) => proposal.status === "applied" && h.decision === "accepted")
      .map((h) => ({
        id: h.id,
        ordinal: h.ordinal,
        op: h.op,
        baseStart: h.baseStart,
        baseEnd: h.baseEnd,
        proposedText: h.proposedText,
        decision: h.decision,
      }));
    const outcome = computeProposalOutcome(proposal.status, hunks);
    return compact({
      found: true as const,
      proposalId: proposal.id,
      kind: isCreateProposal(proposal)
        ? ("create" as const)
        : ("edit" as const),
      documentSlug: proposal.documentSlug,
      baseDocVersion: proposal.baseDocVersion,
      outcome,
      resultingDocVersion: proposal.resultDocVersion ?? undefined,
      reviewerNote: proposal.reviewerNote ?? undefined,
      resolvedAt: proposal.resolvedAt ?? undefined,
      acceptedHunks,
      messages: messages.map((message) => ({
        id: message.id,
        body: message.body,
        role:
          message.createdBy === proposal.createdBy
            ? ("proposer" as const)
            : ("reviewer" as const),
        channel: message.channel,
        createdAt: message.createdAt,
      })),
    });
  }

  async addSuggestionMessage(
    input: AddSuggestionMessageInput,
  ): Promise<AddSuggestionMessageResult> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(
      now,
      (ctx) => addSuggestionMessageCommand(ctx, input),
      (out) =>
        out.result.ok
          ? {
              area: "review",
              action: "suggestion.replied",
              actorId: input.createdBy,
              docSlug: out.result.documentSlug,
              channel: input.channel,
            }
          : undefined,
    );
    return outcome.result;
  }

  // Caller-scoped MCP reply. The expected creator guard is enforced inside
  // the write transaction, so a guessed id cannot race into another caller's
  // proposal and a terminal proposal cannot receive a late reply.
  async replyToProposal(
    callerRef: CallerRef,
    proposalId: number,
    body: string,
  ): Promise<AddSuggestionMessageResult> {
    return this.addSuggestionMessage({
      suggestionId: proposalId,
      body,
      createdBy: callerRef,
      channel: "mcp",
      expectedCreatedBy: callerRef,
    });
  }

  // Open create-proposals for the review surface (humans only — never
  // reachable through the McpExecutor port).
  async listCreateProposals(): Promise<readonly CreateProposalView[]> {
    const u = await this.read();
    const proposals = await u.suggestions.openCreates();
    const messages = await u.suggestions.messagesForSuggestions(
      proposals.map((proposal) => proposal.id),
    );
    return proposals.map((proposal) =>
      createProposalView(
        proposal,
        messages
          .filter((message) => message.suggestionId === proposal.id)
          .map((message) => ({
            id: message.id,
            body: message.body,
            createdBy: message.createdBy,
            channel: message.channel,
            createdAt: message.createdAt,
          })),
      ),
    );
  }

  async applyCreateProposal(
    input: ApplyCreateProposalInput,
  ): Promise<ApplyCreateProposalResult> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(
      now,
      (ctx) => applyCreateProposalCommand(ctx, input),
      (out) =>
        out.result.ok
          ? {
              area: "review",
              action: "suggestion.applied",
              actorId: input.appliedBy,
              docSlug: out.result.documentSlug,
              docVersion: out.result.docVersion,
            }
          : undefined,
    );
    return outcome.result;
  }

  // Open-suggestion counts per document, for the documents-list badge that
  // tells a reviewer which docs have proposals waiting (the presence channel
  // only nudges open tabs). One aggregate read.
  async openSuggestionCounts(): Promise<Readonly<Record<string, number>>> {
    const u = await this.read();
    return u.suggestions.openCountsByDoc();
  }

  async listSuggestions(
    slug: DocumentSlug,
  ): Promise<readonly SuggestionView[]> {
    return this.suggestionViews(await this.read(), slug);
  }

  private async suggestionViews(
    u: Unit,
    slug: DocumentSlug,
  ): Promise<readonly SuggestionView[]> {
    // The document review rail is strictly the EDIT surface; create-proposal
    // rows (baseDocVersion 0) that share this slug's history — e.g. a stale
    // proposal for a slug that later got created — list separately via
    // listCreateProposals, and would render as a nonsense zero-hunk card here.
    const suggestions = (await u.suggestions.forDoc(slug)).filter(
      (s) => !isCreateProposal(s),
    );
    const ids = suggestions.map((s) => s.id);
    const [hunks, messages] = await Promise.all([
      u.suggestions.hunksForSuggestions(ids),
      u.suggestions.messagesForSuggestions(ids),
    ]);
    return suggestions.map((s) => ({
      id: s.id,
      status: s.status,
      baseDocVersion: s.baseDocVersion,
      granularity: s.granularity,
      proposedMarkdown: s.proposedMarkdown,
      createdBy: s.createdBy,
      channel: s.channel,
      createdAt: s.createdAt,
      reviewerNote: s.reviewerNote,
      hunks: hunks
        .filter((h) => h.suggestionId === s.id)
        .map((h) => ({
          id: h.id,
          ordinal: h.ordinal,
          op: h.op,
          baseStart: h.baseStart,
          baseEnd: h.baseEnd,
          proposedText: h.proposedText,
          decision: h.decision,
        })),
      messages: messages
        .filter((message) => message.suggestionId === s.id)
        .map((message) => ({
          id: message.id,
          body: message.body,
          createdBy: message.createdBy,
          channel: message.channel,
          createdAt: message.createdAt,
        })),
    }));
  }

  async setHunkDecision(
    input: SetHunkDecisionInput,
  ): Promise<Readonly<{ ok: boolean }>> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      setHunkDecisionCommand(ctx, input),
    );
    return outcome.result;
  }

  async applySuggestion(
    input: ApplySuggestionInput,
  ): Promise<ApplySuggestionResult> {
    const now = new Date().toISOString();
    try {
      const outcome = await this.writeCommand(
        now,
        (ctx) => applySuggestionCommand(ctx, input),
        (out) =>
          out.result.ok
            ? {
                area: "review",
                action: "suggestion.applied",
                actorId: input.appliedBy,
                docSlug: out.result.documentSlug,
                docVersion: out.result.docVersion,
              }
            : undefined,
      );
      return outcome.result.ok
        ? { ok: true, docVersion: outcome.result.docVersion }
        : outcome.result;
    } catch (err) {
      // A partial acceptance splices hunks into the base, and the spliced
      // document can exceed MAX_MARKDOWN_BYTES even though the base and the
      // proposal were each admitted under it. The save path's sentinel rolls
      // the whole apply back; surface it as a structured refusal.
      if (err instanceof MarkdownTooLarge) {
        return { ok: false, reason: "too-large" };
      }
      throw err;
    }
  }

  async rejectSuggestion(
    input: RejectSuggestionInput,
  ): Promise<Readonly<{ ok: boolean }>> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(
      now,
      (ctx) => rejectSuggestionCommand(ctx, input),
      (out) =>
        out.result.ok && out.result.documentSlug !== undefined
          ? {
              area: "review",
              action: "suggestion.rejected",
              actorId: input.rejectedBy,
              docSlug: out.result.documentSlug,
            }
          : undefined,
    );
    return { ok: outcome.result.ok };
  }

  // Rename a document = a title-only head-pointer edit. Distinct from
  // saveDocument: no blob, no DocumentVersion, no docVersion bump — the
  // content-addressed chain is untouched, so verifyHistory stays green.
  // ok:false only when the document is absent; an unchanged title is
  // an idempotent ok:true no-op (no event, mirrors createCollection).
  // The rename still fans out to collections that include the doc so
  // subscribed agents see the new title.
  async renameDocument(input: RenameDocumentInput): Promise<{ ok: boolean }> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      renameDocumentCommand(ctx, input),
    );
    return { ok: outcome.result.status !== "missing" };
  }

  // First-class `filename` rename. Shares `renameDocument`'s head-edit
  // primitive (no blob / DocumentVersion / docVersion bump) but is a
  // DISTINCT op: a filename change is a path-map mutation — every
  // document that links the renamed file by a relative path now
  // resolves differently with NO byte change in those sources — so it
  // composes the doc-event delivery with the coarse path-map fan-out
  // (`renameDocument`, title-only, deliberately does NOT fan out).
  // Sibling-namespace uniqueness is the same cross-type (folder|doc)
  // segment rule `placeDocument` enforces; race-free inside this tx
  // because the DO serializes requests per Project.
  async renameFilename(
    input: RenameFilenameInput,
  ): Promise<RenameFilenameResult> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      renameFilenameCommand(ctx, input),
    );
    return outcome.result;
  }

  async createCollection(input: {
    slug: CollectionSlug;
    name: string;
    description?: string;
    alwaysIncludeBudgetTokens?: number;
    changedBy: string;
  }): Promise<{ slug: CollectionSlug }> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      createCollectionCommand(ctx, input),
    );
    return outcome.result;
  }

  // Edit a collection's name/description. Membership is unchanged, so
  // NO new `CollectionVersion` is cut (head-node metadata only) and
  // slug — the identity pinned in every `CollectionVersion` / the
  // bundle sort key — is never touched. ok:false only when the
  // collection is absent; an unchanged name+description is an
  // idempotent ok:true no-op.
  async updateCollection(
    input: UpdateCollectionInput,
  ): Promise<{ ok: boolean }> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      updateCollectionCommand(ctx, input),
    );
    return { ok: outcome.result.status !== "missing" };
  }

  // The agent-facing folder projection: tree-ordered documents with
  // derived paths and resolved relative links — the whole hierarchy +
  // link graph in one read. Canonical bytes are never rewritten; links
  // are resolved here against the current path map.
  async collectionOutline(
    collectionSlug: CollectionSlug,
  ): Promise<CollectionOutline> {
    return collectionOutlineProjection(
      await this.read(),
      collectionSlug,
      this.parsedLinksByHash,
    );
  }

  // Attach (or re-position) a document in a collection. A new edge emits
  // collection.attached; moving an existing one collection.reordered.
  async attachDocument(
    collectionSlug: CollectionSlug,
    documentSlug: DocumentSlug,
    position: number,
    changedBy: string,
    delivery: CollectionDelivery = DEFAULT_COLLECTION_DELIVERY,
  ): Promise<{ ok: boolean }> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      attachDocumentCommand(ctx, {
        collectionSlug,
        documentSlug,
        position,
        delivery,
        changedBy,
      }),
    );
    return outcome.result;
  }

  // Membership-affecting change → fresh immutable CollectionVersion, exactly
  // like attach. `mutate` performs the edge change and returns the
  // CollectionChange (or undefined for a no-op); the snapshot + ledger
  // append are shared so detach and reorder can't drift from attach.
  // Cut a fresh immutable CollectionVersion from the current resolved
  // expansion. The single place a snapshot is taken — every
  // membership-affecting path (attach/detach/reorder, and folder
  // delete's link release) routes through here so a collection's
  // latest `CollectionVersion` never lags what `readCollection` /
  // `exportBundle` show.
  private async snapshotCollection(
    u: Unit,
    collectionSlug: CollectionSlug,
    changedBy: string,
    now: string,
  ): Promise<void> {
    const colNode = await u.cols.findCollection(collectionSlug);
    const views = await resolvedViews(u, collectionSlug);
    if (colNode === undefined || views === undefined) return;
    const nextColVersion =
      (await u.versions.latestCollectionVersion(collectionSlug)) + 1;
    await u.versions.appendCollectionVersion(
      colNode.id,
      collectionVersionSnapshot({
        collectionSlug,
        collectionVersion: nextColVersion,
        members: collectionSnapshotMembers(views),
        changedAt: now,
        changedBy,
      }),
    );
  }

  // Remove a document from a collection. No-op (ok:false) when the
  // edge wasn't there, so a double-click can't double-snapshot.
  async detachDocument(
    collectionSlug: CollectionSlug,
    documentSlug: DocumentSlug,
    changedBy: string,
  ): Promise<{ ok: boolean }> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      detachDocumentCommand(ctx, {
        collectionSlug,
        documentSlug,
        changedBy,
      }),
    );
    return outcome.result;
  }

  // ok:false = it didn't exist or was already archived.
  async archiveDocument(
    slug: DocumentSlug,
    changedBy: string,
  ): Promise<{ ok: boolean }> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      archiveOneDocumentCommand(ctx, { slug, changedBy }),
    );
    return { ok: outcome.result.archived };
  }

  // Bulk soft-delete: one atomic tx over the selected slugs (all-or-
  // nothing). Missing / already-archived slugs are skipped, not errors;
  // `archived` is how many were actually archived.
  async archiveDocuments(
    slugs: readonly DocumentSlug[],
    changedBy: string,
  ): Promise<{ archived: number }> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      archiveDocumentsCommand(ctx, { slugs, changedBy }),
    );
    return outcome.result;
  }

  // Set the absolute order of a collection's documents (the UI sends
  // the full current membership in the new order). One snapshot,
  // one event.
  async reorderCollectionDocuments(
    collectionSlug: CollectionSlug,
    orderedDocumentSlugs: readonly DocumentSlug[],
    changedBy: string,
  ): Promise<{ ok: boolean }> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      reorderCollectionDocumentsCommand(ctx, {
        collectionSlug,
        orderedDocumentSlugs,
        changedBy,
      }),
    );
    return outcome.result;
  }

  // Flip a document member's delivery tier (core ↔ reference) WITHOUT
  // re-attaching. A tier change is membership-affecting (the resolved
  // corpus changes), so it cuts a fresh CollectionVersion + event via the
  // shared mutation path — but it must NOT go through attach, whose
  // position argument (the caller only has the *resolved* index, not
  // the stored edge position) would corrupt member order in
  // folder-linked collections. `ok:false` when the doc isn't a member
  // or is already that tier.
  async setMemberDelivery(
    collectionSlug: CollectionSlug,
    documentSlug: DocumentSlug,
    delivery: CollectionDelivery,
    changedBy: string,
  ): Promise<{ ok: boolean }> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      setMemberDeliveryCommand(ctx, {
        collectionSlug,
        documentSlug,
        delivery,
        changedBy,
      }),
    );
    return outcome.result;
  }

  // Folder-link counterpart of `setMemberDelivery`.
  async setFolderLinkDelivery(
    collectionSlug: CollectionSlug,
    folderSlug: FolderSlug,
    delivery: CollectionDelivery,
    changedBy: string,
  ): Promise<{ ok: boolean }> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      setFolderLinkDeliveryCommand(ctx, {
        collectionSlug,
        folderSlug,
        delivery,
        changedBy,
      }),
    );
    return outcome.result;
  }

  // Attach (or re-position) a folder→collection link. Membership-affecting
  // → a fresh CollectionVersion is cut via the shared resolved() snapshot
  // path, exactly like a document attach.
  async attachFolderToCollection(
    collectionSlug: CollectionSlug,
    folderSlug: FolderSlug,
    position: number,
    changedBy: string,
    delivery: CollectionDelivery = DEFAULT_COLLECTION_DELIVERY,
  ): Promise<{ ok: boolean }> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      attachFolderToCollectionCommand(ctx, {
        collectionSlug,
        folderSlug,
        position,
        delivery,
        changedBy,
      }),
    );
    return outcome.result;
  }

  async detachFolderFromCollection(
    collectionSlug: CollectionSlug,
    folderSlug: FolderSlug,
    changedBy: string,
  ): Promise<{ ok: boolean }> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      detachFolderFromCollectionCommand(ctx, {
        collectionSlug,
        folderSlug,
        changedBy,
      }),
    );
    return outcome.result;
  }

  // — Folders ————————————————————————————————————————————————————————
  //
  // Authoring-plane organization (single-parent tree). Mutations are
  // web / server-fn only (MCP stays read-only). A path-space mutation
  // (rename / move / delete-rehome / re-place) changes the resolved
  // expansion of every folder-linking collection without changing any
  // single document — so we fan out a coarse `collection.reordered`
  // event to those collections. `readCollection` re-resolves the tree
  // on the next read, so the event is purely audit/notification.

  // Slug is derived from the name at creation (collision-suffixed
  // against existing folder slugs) and stable thereafter — renames
  // change `name` only, never the slug. A new (empty) folder changes no
  // existing expansion, so creation needs no fan-out.
  async createFolder(
    name: string,
    parentSlug: FolderSlug | null,
  ): Promise<
    Readonly<
      { ok: true; slug: string } | { ok: false; reason: "segment-collision" }
    >
  > {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      createFolderCommand(ctx, { name, parentSlug }),
    );
    return outcome.result;
  }

  renameFolder(
    slug: FolderSlug,
    name: string,
    changedBy: string,
  ): Promise<RenameFolderResult> {
    const now = new Date().toISOString();
    return this.writeCommand(now, (ctx) =>
      renameFolderCommand(ctx, { slug, name, changedBy }),
    ).then((outcome) => outcome.result);
  }

  moveFolder(
    slug: FolderSlug,
    newParentSlug: FolderSlug | null,
    changedBy: string,
  ): Promise<MoveFolderResult> {
    const now = new Date().toISOString();
    return this.writeCommand(now, (ctx) =>
      moveFolderCommand(ctx, { slug, newParentSlug, changedBy }),
    ).then((outcome) => outcome.result);
  }

  // Delete releases each linking collection's `includes_folder` edge;
  // that is a membership change, so those collections get a fresh
  // snapshot in the SAME tx (otherwise they'd drop out of the
  // folder-linked set and `exportBundle` would serve a stale pre-delete
  // snapshot). Other still-folder-linked collections get the coarse
  // path-map signal.
  async deleteFolder(
    slug: FolderSlug,
    changedBy: string,
  ): Promise<DeleteFolderResult> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      deleteFolderCommand(ctx, { slug, changedBy }),
    );
    return outcome.result;
  }

  placeDocumentInFolder(
    documentSlug: DocumentSlug,
    folderSlug: FolderSlug | null,
    changedBy: string,
  ): Promise<PlaceDocumentResult> {
    const now = new Date().toISOString();
    return this.writeCommand(now, (ctx) =>
      placeDocumentInFolderCommand(ctx, {
        documentSlug,
        folderSlug,
        changedBy,
      }),
    ).then((outcome) => outcome.result);
  }

  // Bulk move into one folder, best-effort in a single tx: a per-doc
  // collision is a no-op (placeDocument never mutates on failure), so the
  // ones that can move do, and the rest are counted. One fan-out after,
  // forwarded to the durable instrumentation stream post-commit.
  async placeDocumentsInFolder(
    documentSlugs: readonly DocumentSlug[],
    folderSlug: FolderSlug | null,
    changedBy: string,
  ): Promise<Readonly<{ moved: number; failed: number }>> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      placeDocumentsInFolderCommand(ctx, {
        documentSlugs,
        folderSlug,
        changedBy,
      }),
    );
    return outcome.result;
  }

  async listFolders(): Promise<readonly FolderView[]> {
    return (await this.read()).folders.listAll();
  }

  // Bulk folder upload, ONE document at a time. The whole per-document
  // import — ensure ancestor folders → resolve/reuse slug → append a
  // DocumentVersion → place the `in_folder` edge — is a single atomic
  // `write()`. A tree upload is N of these (bounded per-document
  // atomicity, never one giant tx). Idempotent on the derived path: a
  // re-upload resolves to the existing document at that path and bumps
  // its version; a fresh path mints a stable, collision-suffixed slug.
  // A folder/document segment collision throws ImportAbort → the whole
  // unit rolls back (nothing partially written).
  async importDocumentAtPath(
    input: Readonly<{ path: string; markdown: string; changedBy: string }>,
  ): Promise<ImportDocResult> {
    const now = new Date().toISOString();
    try {
      const outcome = await this.writeCommand(now, (ctx) =>
        importDocumentAtPathCommand(ctx, input),
      );
      return outcome.result;
    } catch (err) {
      if (err instanceof ImportAbort) {
        return { ok: false, reason: err.reason };
      }
      // An oversized file fails only ITS OWN per-document unit; the caller
      // records it in `failed` and the rest of the tree import proceeds.
      if (err instanceof MarkdownTooLarge) {
        return { ok: false, reason: "too-large" };
      }
      throw err;
    }
  }

  // Drive a whole tree upload: N independent atomic imports (one
  // write() each — never one giant tx). Processed in the given order so
  // ancestor folders are reused as they appear. Aggregates the summary,
  // every landed document's slug + immediate folder (upload order — the
  // link step's input), and the set of folders this import created (the
  // signal for which folder, if any, is a fresh linkable wrapper).
  private async runImport(
    entries: readonly Readonly<{ path: string; markdown: string }>[],
    changedBy: string,
  ): Promise<
    Readonly<{
      summary: ImportSummary;
      imported: readonly Readonly<{
        slug: DocumentSlug;
        folderSlug: FolderSlug | null;
      }>[];
      createdFolderSlugs: ReadonlySet<FolderSlug>;
    }>
  > {
    let created = 0;
    let updated = 0;
    const failed: { path: string; reason: string }[] = [];
    const imported: { slug: DocumentSlug; folderSlug: FolderSlug | null }[] =
      [];
    const createdFolderSlugs = new Set<FolderSlug>();
    for (const e of entries) {
      const r = await this.importDocumentAtPath({
        path: e.path,
        markdown: e.markdown,
        changedBy,
      });
      if (r.ok) {
        if (r.created) created += 1;
        else updated += 1;
        imported.push({
          slug: asDocumentSlug(r.slug),
          folderSlug: r.folderSlug === null ? null : asFolderSlug(r.folderSlug),
        });
        for (const f of r.createdFolders)
          createdFolderSlugs.add(asFolderSlug(f));
      } else {
        failed.push({ path: e.path, reason: r.reason });
      }
    }
    return {
      summary: { created, updated, failed },
      imported,
      createdFolderSlugs,
    };
  }

  async importDocuments(
    entries: readonly Readonly<{ path: string; markdown: string }>[],
    changedBy: string,
  ): Promise<ImportSummary> {
    return (await this.runImport(entries, changedBy)).summary;
  }

  async importDocumentsAndLink(
    input: ImportAndLinkInput,
  ): Promise<ImportAndLinkResult> {
    const { summary, imported, createdFolderSlugs } = await this.runImport(
      input.entries,
      input.changedBy,
    );
    const { link } = input;
    if (link.mode === "none" || imported.length === 0) {
      return { summary, linkedTo: undefined };
    }

    const collectionSlug =
      link.mode === "existing"
        ? link.slug
        : asCollectionSlug(slugify(link.name));
    const now = new Date().toISOString();

    // Derive the link target from ground truth, never a client flag:
    // build each document's folder ancestry from the live tree, then ask
    // the domain rule for the fresh wrapper folder (if any) vs the
    // documents. This is what makes the folder-vs-documents choice
    // un-forgeable — a caller cannot point the link at a pre-existing
    // folder it did not just create.
    const folders = await this.listFolders();
    const parentOf = new Map<string, string | null>(
      folders.map((f) => [f.slug, f.parentSlug]),
    );
    const folderChain = (leaf: FolderSlug | null): readonly FolderSlug[] => {
      const chain: FolderSlug[] = [];
      const seen = new Set<string>();
      for (let cur: string | null = leaf; cur !== null && !seen.has(cur);) {
        seen.add(cur);
        chain.unshift(asFolderSlug(cur));
        cur = parentOf.get(cur) ?? null;
      }
      return chain;
    };
    const target = chooseImportLinkTarget(
      imported.map((d) => folderChain(d.folderSlug)),
      createdFolderSlugs,
    );

    const linked = await this.writeCommand(now, (ctx) =>
      target.kind === "folder"
        ? linkImportedFolderCommand(ctx, {
            folderSlug: target.folderSlug,
            collectionSlug,
            link,
            delivery: "reference",
            changedBy: input.changedBy,
          })
        : linkImportedDocumentsCommand(ctx, {
            documentSlugs: imported.map((d) => d.slug),
            collectionSlug,
            link,
            delivery: "reference",
            changedBy: input.changedBy,
          }),
    );
    return { summary, linkedTo: linked.result.linkedTo };
  }

  // The example project: refund-policy + product + brand-voice,
  // Support + Sales collections. refund-policy linked into BOTH (the
  // shared-node "no copies" teaching moment); product and brand-voice
  // into Sales only (present, not stranded). One atomic tx over all
  // writes — a partial seed (the broken half-graph) is impossible.
  // No-op if the project already has any document or collection, so a
  // double-click on a populated project never errors on a brand-new
  // user's first action.
  async seedExample(changedBy: string): Promise<SeedResult> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      seedExampleCommand(ctx, changedBy),
    );
    return outcome.result;
  }
}
