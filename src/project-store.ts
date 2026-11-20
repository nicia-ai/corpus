import {
  BLOCK_PARSER_VERSION,
  computeProposalOutcome,
  isCreateProposal,
  parseBlocksWithRanges,
} from "@nicia-ai/prose-diff";
import {
  createAdapterStoreWithSchema,
  type GraphBackend,
} from "@nicia-ai/typegraph";
import { createSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";
import {
  getCommittedSchemaVersion,
  getSchemaChanges,
  migrateSchema,
  type NodeChange,
} from "@nicia-ai/typegraph/schema";
import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import { ledgerMigrations } from "../drizzle-do/migrations";

import {
  defaultCorpusIsBound,
  rebindDefaultCorpusConnections,
} from "./control/connections";
import { connectControlDb } from "./control/db";
import type { LedgerDb } from "./db";
import { EMBASSY_ACTOR_LABEL } from "./embassy/actor";
import { ConflictError, isUniqueViolation, RollbackProbe } from "./errors";
import { canonicalGraph } from "./graph";
import {
  asCorpusSlug,
  asDocumentSlug,
  type CorpusSlug,
  type DocumentSlug,
  type FolderSlug,
  asProjectId,
  type CallerRef,
  parseCallerRef,
  type ProjectId,
} from "./ids";
import {
  type CommandOutcome,
  corpusSnapshotMembers,
  type DomainChange,
  isDocumentChange,
  type ProjectCommandContext,
} from "./project-store/command";
import {
  exportBundleProjection,
  importBundleCommand,
} from "./project-store/commands/bundle";
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
  createCorpusCommand,
  updateCorpusCommand,
} from "./project-store/commands/corpora";
import {
  corpusOfDocument,
  corpusTreeChanged,
} from "./project-store/commands/corpus-tree";
import { deleteCorpusCommand } from "./project-store/commands/delete-corpus";
import {
  archiveDocumentsCommand,
  archiveOneDocumentCommand,
  FilenameCollision,
  ImportAbort,
  importDocumentAtPathCommand,
  MarkdownTooLarge,
  renameDocumentCommand,
  createInCorpusAtPathCommand,
  renameFilenameCommand,
  saveDocumentCommand,
  saveOrCreateDocumentCommand,
} from "./project-store/commands/documents";
import {
  DRIVE_LAYOUT_ACTOR,
  layOutAsDrivesCommand,
} from "./project-store/commands/drive-layout";
import { ensureDefaultCorpusCommand } from "./project-store/commands/ensure-default-corpus";
import {
  createFolderCommand,
  type CreateFolderResult,
  deleteFolderCommand,
  moveDocumentCommand,
  moveDocumentsCommand,
  moveFolderCommand,
  renameFolderCommand,
} from "./project-store/commands/folders";
import { saveSectionCommand } from "./project-store/commands/sections";
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
  proposalInCorpus,
  type ProposalResult,
  type RejectSuggestionInput,
  setHunkDecisionCommand,
  type SetHunkDecisionInput,
  type SuggestCreateInput,
  type SuggestionView,
} from "./project-store/commands/suggestions";
import { checkedPathSegments } from "./project-store/commands/untrusted-path";
import type {
  CorpusFolderView,
  CorpusOutline,
  CreateInCorpusResult,
  DeleteCorpusInput,
  DeleteCorpusResult,
  DocumentHistoryEntry,
  DocumentHistoryMeta,
  DocumentListRow,
  DocumentLocation,
  DocumentRef,
  DocumentSearchHit,
  DocumentSnapshot,
  EnsureDefaultCorpusResult,
  ImportDocResult,
  ImportIntoCorpusInput,
  ImportIntoCorpusResult,
  ImportResult,
  ImportSummary,
  MoveDocumentsResult,
  ProjectUsageSnapshot,
  ReapResult,
  RenameDocumentInput,
  RenameFilenameInput,
  RenameFilenameResult,
  SaveDocumentInput,
  SaveResult,
  SaveSharedDraftResult,
  SaveSharedSectionInput,
  SaveSharedSectionResult,
  SeedResult,
  UpdateCorpusInput,
} from "./project-store/contracts";
import { ProjectInstrumentation } from "./project-store/outbox";
import {
  ClientMessage,
  presenceFrom,
  type RealtimeChange,
  SocketAttachment,
  type SocketMeta,
} from "./project-store/presence";
import { projectStatsProjection } from "./project-store/project-stats";
import {
  corpusMembersProjection,
  corpusMetaProjection,
  corpusOutlineProjection,
  documentHistoryPageProjection,
  documentHistoryProjection,
  documentHistoryVersionProjection,
  documentLocationProjection,
  getDocumentProjection,
  listCorporaProjection,
  listDocumentRefsProjection,
  listDocumentsProjection,
  listFoldersProjection,
  resolvedMembersProjection,
  resolvedViews,
  searchDocumentsProjection,
  usageSnapshotProjection,
  verifyHistoryProjection,
} from "./project-store/queries";
import { reapExpiredRecords } from "./project-store/retention";
import type { ProjectUnit } from "./project-store/unit";
import type { Bundle, BundleSource } from "./store/domain/bundle";
import {
  type CorpusLocation,
  corpusIsServed,
} from "./store/domain/corpus-drive";
import { DEFAULT_CORPUS_SLUG } from "./store/domain/default-corpus";
import { events as buildEvent } from "./store/domain/instrumentation-events";
import type { ParsedLink } from "./store/domain/links";
import type { ProjectStats } from "./store/domain/project-stats";
import type { RetentionPolicy } from "./store/domain/retention";
import { deriveSearchText } from "./store/domain/search";
import type { VerifyResult } from "./store/domain/verify";
import { collectionVersionSnapshot } from "./store/domain/versions";
import type { CorpusStore, GraphHandle } from "./store/handle";
import { BlobStore } from "./store/repos/blob-store";
import { BlockMapRepo } from "./store/repos/block-map";
import { ChangeLog, type RecentChange } from "./store/repos/change-log";
import { CorpusGraph, type CorpusMeta } from "./store/repos/collection-graph";
import { CommentRepo } from "./store/repos/comment";
import {
  DocumentRepo,
  type RecentDocumentRow,
} from "./store/repos/document-repo";
import {
  type DeleteFolderResult,
  FolderRepo,
  type MoveFolderResult,
  type PlaceDocumentResult,
  type RenameFolderResult,
} from "./store/repos/folder-repo";
import { InstrumentationOutbox } from "./store/repos/instrumentation-outbox";
import { SuggestionRepo } from "./store/repos/suggestion";
import { VersionRepo } from "./store/repos/version-repo";
import { graphStatementLogger } from "./store/statement-log";
import { compact, sha256, slugify } from "./util";

export type {
  CorpusFolderView,
  CorpusOutline,
  CreateInCorpusResult,
  DeleteCorpusInput,
  DeleteCorpusResult,
  DocumentHistoryEntry,
  DocumentListRow,
  DocumentLocation,
  DocumentRef,
  EnsureDefaultCorpusResult,
  ImportDestination,
  ImportDocResult,
  ImportIntoCorpusInput,
  ImportIntoCorpusResult,
  ImportResult,
  ImportSummary,
  MoveDocumentsResult,
  ProjectUsageSnapshot,
  ReapResult,
  RenameDocumentInput,
  RenameFilenameInput,
  RenameFilenameResult,
  SaveDocumentInput,
  SaveResult,
  SeedResult,
  UpdateCorpusInput,
} from "./project-store/contracts";

type Unit = ProjectUnit;

// Persistent marker: set once the one-time `searchText` backfill has run for
// this DO, so a reindex never repeats across restarts.
const SEARCH_BACKFILL_KEY = "search:backfilled:v1";
// Documents reindexed per backfill transaction — bounds the work (blob reads
// + node updates) in any single transaction for an unbounded legacy project.
const SEARCH_BACKFILL_BATCH = 100;
// Persistent marker: set once this DO's project has been laid out as
// drives (every corpus has a root folder, every document is under one), so
// the one-time layout migration never repeats across restarts.
const DRIVE_LAYOUT_KEY = "layout:corpus-drive:v1";
// Placements one layout transaction commits (see `layOutAsDrivesCommand`).
const DRIVE_LAYOUT_BATCH = 200;

// Maps a committed command's outcome to the real-time change to broadcast,
// or undefined to fall back to the domain-derived change. Always a function
// so the broadcast can be conditioned on whether the command actually
// succeeded (a returned `{ ok: false }` must not broadcast a phantom event).
type RealtimeChangeResolver<T> = (
  outcome: CommandOutcome<T>,
) => RealtimeChange | undefined;

export type DocumentReviewSnapshot = Readonly<{
  doc: DocumentSnapshot | undefined;
  // The corpus the document is in and its path inside it.
  location: DocumentLocation | undefined;
  // Who wrote the head version; the document node itself does not record it.
  headChange: Readonly<{ changedBy: string; changedAt: string }> | undefined;
  blocks: DocumentBlocksResult;
  comments: readonly CommentThreadView[];
  suggestions: readonly SuggestionView[];
}>;

export type DocumentHistoryPageSnapshot = Readonly<{
  doc: DocumentSnapshot | undefined;
  history: readonly DocumentHistoryMeta[];
  active: DocumentHistoryEntry | undefined;
}>;

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
  // Prefer the document change when a command emits several (archiving a
  // document emits its corpus's tree change first, then the
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
    area: "corpus" as const,
    action: change.kind,
    actorId: change.changedBy,
    collectionSlug: change.collectionSlug,
    docSlug: change.documentSlug,
  });
}

// One ProjectStore instance per Project. TypeGraph (Document/
// DocumentVersion/Corpus/CorpusVersion/edges) and the Drizzle
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
  private store: CorpusStore | undefined;
  private initPromise: Promise<CorpusStore> | undefined;
  // The DO's storage is stable for its lifetime, so the read-side ledger
  // handle is built once (writes use the tx-scoped handle).
  private ledger: LedgerDb | undefined;
  // The content-keyed link lens: a document's relative-link set is a
  // pure function of its immutable bytes, so it is parsed once per
  // contentHash and never invalidated (content never mutates).
  private readonly parsedLinksByHash = new Map<string, readonly ParsedLink[]>();
  // Per-(callerRef, corpusSlug) version-fingerprint cache. A
  // routine repeat poll with no intervening edit produces the same
  // fingerprint as the prior cached read, so the cross-DO append is
  // skipped entirely. The cache is ephemeral (DO restart loses it);
  // a re-emit after restart collapses at the EventLogStore via the
  // unique idempotency_key, so the projection never double-counts.
  // Bounded by the active set of callers × corpora.
  private readonly readDedupCache = new Map<string, string>();
  private instrumentationOutbox: ProjectInstrumentation | undefined;
  // Cleared until the one-time `searchText` backfill has run for this DO
  // (see `ensureSearchBackfilled`); mirrors a persistent storage marker so
  // the reindex happens at most once per DO, not once per instance.
  private searchBackfilled = false;
  // The in-flight / finished drive-layout check (see `ensureDriveLayout`);
  // mirrors the persistent marker so it runs at most once per DO.
  private driveLayout: Promise<void> | undefined;

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
      corpus: {
        resolvedViews,
        snapshot: (unit, slug, changedBy, changedAt) =>
          this.snapshotCorpus(unit, slug, changedBy, changedAt),
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
    if (parseCallerRef(change.actorId).kind === "embassy") {
      return { ...change, actorName: EMBASSY_ACTOR_LABEL };
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
  // hands us the CallerRef, the bound corpusSlug, and the
  // version-set the read actually saw. We emit at most ONE event per
  // state change:
  //   * first time this caller reads this corpus → `read.first`
  //   * subsequent read whose captured-version-set differs from the
  //     prior cached fingerprint → `read.after-edit`
  //   * subsequent read with the same fingerprint → no event
  // Failures are logged and swallowed — same posture as save events.
  async recordRead(
    callerRef: CallerRef,
    corpusSlug: string,
    versionCapturedAtRead: Readonly<Record<string, number>>,
  ): Promise<void> {
    const cacheKey = `${callerRef}|${corpusSlug}`;
    const fingerprint = fingerprintVersions(versionCapturedAtRead);
    const prior = this.readDedupCache.get(cacheKey);
    if (prior === fingerprint) return;
    const event =
      prior === undefined
        ? buildEvent.readFirst({
            callerRef,
            corpusSlug,
            versionCapturedAtRead,
          })
        : buildEvent.readAfterEdit({
            callerRef,
            corpusSlug,
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

  // Each project's graph lives in its own Durable Object — there is no
  // batch "wrangler d1 migrations apply" equivalent that can run a
  // schema migration across every project ahead of a deploy. `ensureStore`
  // is the only place any given project's graph gets touched, so it has
  // to be able to self-heal a schema version bump on next boot, not just
  // bootstrap a brand-new one. `createAdapterStoreWithSchema`'s own
  // `ensureSchema` call already auto-migrates additive (backwards-
  // compatible) diffs; a change TypeGraph classifies as breaking (e.g. a
  // modified node — the 0.50 claim-relations rework, see AGENTS.md)
  // throws `MigrationError` there instead of applying it, by design, so
  // every project's boot would fail hard until a human runs
  // `migrateSchema()` by hand against a DO that request-scoped code can't
  // reach out-of-band.
  //
  // Reviewed once, at the PR that bumped TypeGraph: the only "breaking"
  // classification this graph has ever produced is that claim-relations
  // rework, which replaces an advisory-lock race with a real fenced row
  // and touches no existing field or row data. `migrateSchema` itself
  // still refuses to commit a diff that would drop a populated kind
  // (`reason: "kind-removal"`), so that protection holds regardless —
  // this only forecloses the *review* step for changes TypeGraph is
  // able to auto-migrate outright, which is exactly the class this
  // boot-time call is for. Logged so an unexpected future diff shows up
  // in `wrangler tail` rather than silently sailing through.
  private async migrateGraphSchemaIfNeeded(
    backend: GraphBackend,
  ): Promise<void> {
    // getSchemaChanges (unlike ensureSchema's own loadActiveSchemaWithBootstrap)
    // reads the schema-version table directly with no bootstrap fallback, so
    // it throws on a brand-new project whose graph tables don't exist yet —
    // there is nothing to migrate in that case; createAdapterStoreWithSchema's
    // own initializeSchema path bootstraps it right after this returns.
    let changes;
    try {
      changes = await getSchemaChanges(backend, canonicalGraph);
    } catch (error) {
      if (error instanceof Error && /no such table/iu.test(error.message)) {
        return;
      }
      throw error;
    }
    if (!changes?.hasChanges) return;
    const fromVersion = await getCommittedSchemaVersion(
      backend,
      canonicalGraph.id,
    );
    if (fromVersion === undefined) return;
    console.warn(
      `[typegraph] migrating graph "${canonicalGraph.id}" v${String(fromVersion)} -> v${String(fromVersion + 1)}: ${changes.summary}`,
      changes.nodes
        .filter((change: NodeChange) => change.type !== "added")
        .map((change: NodeChange) => `${change.kind}: ${change.details}`),
    );
    await migrateSchema(backend, canonicalGraph, fromVersion);
  }

  // Lazy, idempotent init. The ledger schema (content_blobs,
  // change_events) is applied by the Drizzle DO migrator from the
  // generated bundle — drizzle-kit is the single source of this DDL
  // (src/db.ts → `pnpm db:generate:do`). The migrator runs DDL in its
  // own DO transaction, BEFORE TypeGraph init, so it never touches a
  // TypeGraph enlisted transaction. TypeGraph then bootstraps its own
  // node/edge tables.
  private async ensureStore(): Promise<CorpusStore> {
    if (this.store) return this.store;
    this.initPromise ??= (async () => {
      await migrate(this.ledgerDb(), ledgerMigrations);
      const backend = createSqliteBackend(
        drizzle(this.ctx.storage, { logger: graphStatementLogger }),
      );
      await this.migrateGraphSchemaIfNeeded(backend);
      const [store] = await createAdapterStoreWithSchema(
        canonicalGraph,
        backend,
      );
      const materialized = await store.materializeIndexes({
        stopOnError: true,
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

  private unit(graph: GraphHandle, ledger: LedgerDb): Unit {
    return {
      docs: new DocumentRepo(graph),
      cols: new CorpusGraph(graph),
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

  // The only place a transaction opens. The atomic graph+ledger write rides
  // TypeGraph's native transaction handle, and since 0.39 the non-available
  // `sqlAvailability` arms omit `sql` outright — so this narrowing is what
  // makes `tx.sql` reachable at all, and it doubles as a fail-loud guard for
  // a backend that stops offering raw SQL.
  private async write<T>(fn: (u: Unit) => Promise<T>): Promise<T> {
    await this.ensureDriveLayout();
    return this.transact(fn);
  }

  private async transact<T>(fn: (u: Unit) => Promise<T>): Promise<T> {
    const store = await this.ensureStore();
    return store.transaction((tx) => {
      if (tx.sqlAvailability !== "available") {
        throw new Error(
          `ProjectStore requires a SQL-backed transaction; TypeGraph reported sqlAvailability="${tx.sqlAvailability}"`,
        );
      }
      return fn(this.unit(tx, asLedgerDb(tx.sql)));
    });
  }

  // Non-transactional unit for reads — same repo API, storage handle.
  private async read(): Promise<Unit> {
    await this.ensureDriveLayout();
    const store = await this.ensureStore();
    return this.unit(store, this.ledgerDb());
  }

  // The one-time move of a project written before corpora were drives into
  // the drive layout. Lazy — it runs the first time this DO's data is
  // touched, not at boot. Every read and write waits on it, which is what
  // lets the rest of the code assume the invariant. It is NOT one
  // transaction: see `layOutAsDrivesCommand` for why it is committed in
  // bounded batches, and why the state between batches is safe.
  //
  // What makes it correct is that the pass is idempotent and resumable, not
  // the marker: a failed call leaves every committed batch in place, and the
  // next call recomputes what is left from the graph and carries on; a pass
  // over a project that is already laid out reads, finds nothing, and writes
  // nothing. The persistent marker is written after the last batch only to
  // skip even that read on later starts — a crash between the final commit
  // and the marker costs one cheap re-check, never a repeat of the work.
  private ensureDriveLayout(): Promise<void> {
    return (this.driveLayout ??= this.layOutAsDrives().catch(
      (error: unknown) => {
        this.driveLayout = undefined;
        throw error;
      },
    ));
  }

  // Test seam (like `__failAfterWrites`): a smaller batch, and a hook that
  // runs after each COMMITTED batch (a throw there simulates a crash between
  // batches).
  private layoutTestSeam: {
    batchSize?: number;
    afterBatch?: (committedBatches: number) => void;
  } = {};

  private async layOutAsDrives(): Promise<void> {
    if (await this.ctx.storage.get<boolean>(DRIVE_LAYOUT_KEY)) return;
    const promoteDefault = await this.defaultCorpusWasServed();
    const placementLimit = this.layoutTestSeam.batchSize ?? DRIVE_LAYOUT_BATCH;
    let placed = 0;
    let conflicts = 0;
    let changed = false;
    let promotedTo: CorpusSlug | undefined;
    for (let batches = 1; ; batches += 1) {
      const now = new Date().toISOString();
      const outcome = await this.transact(async (u) => {
        const out = await layOutAsDrivesCommand(this.commandContext(u, now), {
          snapshot: true,
          placementLimit,
          promoteDefault,
        });
        await this.instrumentation().recordChanges(u, out.changes);
        return out;
      });
      placed += outcome.result.placed;
      conflicts += outcome.result.conflicts;
      changed ||= outcome.result.changed;
      promotedTo = outcome.result.promotedTo ?? promotedTo;
      this.layoutTestSeam.afterBatch?.(batches);
      if (outcome.result.complete) break;
    }
    if (promotedTo !== undefined) {
      await rebindDefaultCorpusConnections(connectControlDb(this.env.DB), {
        projectId: this.projectId(),
        to: promotedTo,
      });
    }
    await this.ctx.storage.put(DRIVE_LAYOUT_KEY, true);
    if (changed) {
      console.warn(
        `[corpus-drive] laid out project ${this.projectId()} as drives by ${DRIVE_LAYOUT_ACTOR}: ${String(placed)} documents placed, ${String(conflicts)} multi-corpus documents resolved`,
      );
    }
  }

  // Did this project serve its default corpus (a Connection or API key
  // bound to it, which the old model allowed)? Only the control plane
  // knows, so the DO asks it one narrow question, once, from the migration —
  // the DO already holds its own project id and the same `env` it uses for
  // the event log. A never-named DO (tests) has no project to ask about.
  private async defaultCorpusWasServed(): Promise<boolean> {
    const projectId = this.projectId();
    return projectId === ""
      ? false
      : defaultCorpusIsBound(connectControlDb(this.env.DB), projectId);
  }

  // Tear down all of this project's data (reconcile sweep, after a
  // project soft-delete). Idempotent.
  async purge(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.driveLayout = undefined;
    this.store = undefined;
    this.initPromise = undefined;
    this.ledger = undefined;
  }

  // — Reads ——————————————————————————————————————————————————————————

  async getDocument(slug: DocumentSlug): Promise<DocumentSnapshot | undefined> {
    return getDocumentProjection(await this.read(), slug);
  }

  // A document is served when it is in a corpus agents can read — any
  // corpus but the default one. Answered from where the document is NOW,
  // so a page moved into a named corpus is served from that moment and a
  // page moved back to drafts is not. A document in no corpus at all is
  // treated as served: the share-link rules that ask this then refuse a
  // direct write rather than allow one.
  private async documentServed(u: Unit, slug: DocumentSlug): Promise<boolean> {
    const corpusSlug = await corpusOfDocument(u, slug);
    return corpusSlug === undefined || corpusIsServed(corpusSlug);
  }

  async isDocumentServed(slug: DocumentSlug): Promise<boolean> {
    return this.documentServed(await this.read(), slug);
  }

  async documentLocation(
    slug: DocumentSlug,
  ): Promise<DocumentLocation | undefined> {
    return documentLocationProjection(await this.read(), slug);
  }

  async documentReviewSnapshot(
    slug: DocumentSlug,
  ): Promise<DocumentReviewSnapshot> {
    const u = await this.read();
    const doc = await getDocumentProjection(u, slug);
    if (doc === undefined) {
      return {
        doc: undefined,
        location: undefined,
        headChange: undefined,
        blocks: { found: false },
        comments: [],
        suggestions: [],
      };
    }
    const [location, head, blocks, comments, suggestions] = await Promise.all([
      documentLocationProjection(u, slug),
      u.versions.documentVersion(slug, doc.docVersion),
      this.documentBlocksForHead(u, slug, doc.docVersion, doc.markdown),
      this.commentThreadViews(u, slug),
      this.suggestionViews(u, slug),
    ]);
    const headChange =
      head === undefined
        ? undefined
        : { changedBy: head.changedBy, changedAt: head.changedAt };
    return { doc, location, headChange, blocks, comments, suggestions };
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

  // Every live document with its corpus and corpus-relative path, ordered
  // by corpus then path.
  async listDocuments(): Promise<readonly DocumentListRow[]> {
    return listDocumentsProjection(await this.read());
  }

  async recentDocuments(): Promise<readonly RecentDocumentRow[]> {
    return (await this.read()).docs.recent(5);
  }

  async listDocumentRefs(): Promise<readonly DocumentRef[]> {
    return listDocumentRefsProjection(await this.read());
  }

  async searchDocuments(query: string): Promise<readonly DocumentSearchHit[]> {
    // Through the layout gate like every read: an un-migrated project has no
    // corpus to attribute a hit to, so every hit would be dropped.
    await this.ensureDriveLayout();
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

  async listCorpora(): Promise<readonly CorpusMeta[]> {
    return listCorporaProjection(await this.read());
  }

  async usageSnapshot(): Promise<ProjectUsageSnapshot> {
    return usageSnapshotProjection(await this.read());
  }

  // Lay this project out as drives now instead of on its next read or write.
  // The scheduled sweep calls it so a project nobody has opened since the
  // drive model shipped does not stay in the old shape.
  async layOutAsDrivesIfNeeded(): Promise<void> {
    await this.ensureDriveLayout();
  }

  // Structural counts for operators (no content, names, or ids). Read-only
  // and off the boot path: only the admin refresh and the daily cron call it.
  // It deliberately does NOT go through `read()`: a project that has not been
  // laid out as drives yet is exactly what it exists to inspect, so it must
  // not trigger the migration.
  async statsSnapshot(): Promise<ProjectStats> {
    const store = await this.ensureStore();
    return projectStatsProjection(
      this.unit(store, this.ledgerDb()),
      this.parsedLinksByHash,
    );
  }

  // Single-corpus head-node lookup — for callers that need the name and
  // description but not its documents. One DO read.
  async corpusMeta(
    corpusSlug: CorpusSlug,
  ): Promise<
    { found: false } | { found: true; name: string; description?: string }
  > {
    return corpusMetaProjection(await this.read(), corpusSlug);
  }

  // The slugs of a corpus's documents — everything under its root — for
  // the MCP / REST scope gate. Shares `resolvedViews` with the outline and
  // the snapshot, so the scope cannot disagree with what is listed.
  // `undefined` = no such corpus.
  async corpusMembers(
    corpusSlug: CorpusSlug,
  ): Promise<readonly string[] | undefined> {
    return corpusMembersProjection(await this.read(), corpusSlug);
  }

  // One row per live document with the corpus it is in. Backs every
  // document-count surface.
  async listResolvedMembers(): Promise<
    readonly Readonly<{ corpusSlug: string; documentSlug: string }>[]
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
  // Heads and versions still pinned by a live CorpusVersion are never
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
  // (the `versions_of` edge needs the head node) → folders → corpora and
  // their `CorpusVersion` snapshots (members pinned verbatim) → the drive
  // layout, which puts every document under its corpus's root.
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
    input: Pick<SaveDocumentInput, "slug" | "clientVersion">,
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

  // Save a document, or create it. A new document is created inside a
  // corpus in the same transaction as the save (`input.location`, the
  // default corpus when absent), so it never exists outside one. A filename
  // collision in the target folder rolls the whole unit back.
  async saveDocument(input: SaveDocumentInput): Promise<SaveResult> {
    const now = new Date().toISOString();
    try {
      const outcome = await this.writeCommand(now, (ctx) =>
        saveOrCreateDocumentCommand(ctx, input),
      );
      return "unknownLocation" in outcome.result
        ? { ok: false, unknownLocation: true }
        : { ok: true, docVersion: outcome.result.docVersion };
    } catch (err) {
      return this.saveError(err, input);
    }
  }

  // A share link may draft directly only while the document is not served
  // — while it sits in the default corpus. Where the document is gets read
  // in the same graph transaction as the save, so the answer is about its
  // location at write time: a concurrent move into a named corpus cannot
  // publish an unreviewed write, and a link's direct-edit right follows the
  // page out of a served corpus as soon as it is moved back to drafts.
  async saveSharedDraft(
    input: SaveDocumentInput,
  ): Promise<SaveSharedDraftResult> {
    const now = new Date().toISOString();
    try {
      const outcome = await this.writeCommand<SaveSharedDraftResult>(
        now,
        async (ctx) => {
          if (await this.documentServed(ctx.u, input.slug)) {
            return {
              result: { ok: false, served: true } as const,
              changes: [],
            };
          }
          const saved = await saveDocumentCommand(ctx, input);
          return {
            result: { ok: true, docVersion: saved.result.docVersion } as const,
            changes: saved.changes,
          };
        },
      );
      return outcome.result;
    } catch (err) {
      return this.saveError(err, input);
    }
  }

  // The section-scoped sibling of saveSharedDraft: same served guard, same
  // transaction, but the write replaces one section of the current head.
  async saveSharedSection(
    input: SaveSharedSectionInput,
  ): Promise<SaveSharedSectionResult> {
    const now = new Date().toISOString();
    try {
      const outcome = await this.writeCommand<SaveSharedSectionResult>(
        now,
        async (ctx) => {
          if (await this.documentServed(ctx.u, input.slug)) {
            return { result: { ok: false, served: true }, changes: [] };
          }
          return saveSectionCommand(ctx, input);
        },
      );
      return outcome.result;
    } catch (err) {
      const failure = await this.saveError(err, input);
      if (failure.ok) throw err;
      return failure;
    }
  }

  // The corpus-scoped REST surface's ONLY write: save a document on behalf
  // of a credential bound to `corpusSlug`. The whole decision is made
  // inside the write, against where the document is at that moment, so no
  // stale member snapshot in a transport can widen the scope:
  //
  //   - slug exists AND is in the bound corpus → a normal save;
  //     `clientVersion` decides (a stale version yields a retryable 409).
  //   - slug exists but is NOT in the bound corpus — it always was
  //     elsewhere, or it was just moved out → `forbidden` (403).
  //   - slug is new → created in the bound corpus's root. If that corpus
  //     vanished under us nothing is written (fail-closed 403): a scoped
  //     create can never land a document outside its own scope.
  //
  // `path` (corpus-relative, optional) says where a NEW document goes:
  // missing folders are created under the corpus root, the last segment is
  // its file name; absent = the corpus top level. It is untrusted input
  // and checked here (`checkedPathSegments`); an existing document ignores it.
  async saveDocumentInCorpus(
    input: SaveDocumentInput,
    corpusSlug: CorpusSlug,
    path?: string,
  ): Promise<CreateInCorpusResult> {
    const now = new Date().toISOString();
    try {
      const outcome = await this.writeCommand<
        { forbidden: true } | { docVersion: number }
      >(now, async (ctx) => {
        const head = await ctx.u.docs.find(input.slug);
        if (
          head !== undefined &&
          (await corpusOfDocument(ctx.u, input.slug)) !== corpusSlug
        ) {
          return { result: { forbidden: true }, changes: [] };
        }
        if (head === undefined && path !== undefined) {
          const created = await createInCorpusAtPathCommand(ctx, {
            ...input,
            corpusSlug,
            path,
          });
          return created.result === undefined
            ? { result: { forbidden: true }, changes: [] }
            : { result: created.result, changes: created.changes };
        }
        const saved = await saveOrCreateDocumentCommand(ctx, {
          ...input,
          location: { corpusSlug, folderSlug: null },
        });
        return "unknownLocation" in saved.result
          ? { result: { forbidden: true }, changes: [] }
          : { result: saved.result, changes: saved.changes };
      });
      return "forbidden" in outcome.result
        ? { ok: false, forbidden: true }
        : { ok: true, docVersion: outcome.result.docVersion };
    } catch (err) {
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
  // already membership-gated `slug` to the caller's bound Corpus, passes
  // that Corpus as `inCorpus` so the gate is re-checked inside the write
  // against where the document is now, and passes the resolved
  // `callerRef` as the author — the agent proposes,
  // only a human accepts. Delegates to createSuggestion so the
  // ConflictError→409 mapping, the write transaction, and the post-commit
  // change broadcast are shared with the web path (no parallel write).
  async suggestEdit(
    callerRef: CallerRef,
    slug: DocumentSlug,
    proposedMarkdown: string,
    baseDocVersion: number,
    inCorpus?: CorpusSlug,
  ): Promise<CreateSuggestionResult> {
    return this.createSuggestion({
      slug,
      proposedMarkdown,
      clientVersion: baseDocVersion,
      createdBy: callerRef,
      inCorpus,
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
  // `originCollectionSlug` with its bound Corpus before the call — so a
  // human apply creates the document in the corpus the agent works in, at
  // the proposed corpus-relative path.
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
    inCorpus?: CorpusSlug,
  ): Promise<ProposalResult> {
    const u = await this.read();
    const proposal = await u.suggestions.get(proposalId);
    if (
      proposal?.createdBy !== callerRef ||
      (inCorpus !== undefined &&
        !(await proposalInCorpus(u, proposal, inCorpus)))
    ) {
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
    inCorpus?: CorpusSlug,
  ): Promise<AddSuggestionMessageResult> {
    return this.addSuggestionMessage({
      suggestionId: proposalId,
      body,
      createdBy: callerRef,
      channel: "mcp",
      expectedCreatedBy: callerRef,
      inCorpus,
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
  // an idempotent ok:true no-op (no event, mirrors createCorpus).
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
  // composes the doc-event delivery with its corpus's tree-changed event
  // (`renameDocument`, title-only, deliberately does not).
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

  // A corpus is created together with its root folder — the one place its
  // documents live. Idempotent on slug.
  async createCorpus(input: {
    slug: CorpusSlug;
    name: string;
    description?: string;
    changedBy: string;
  }): Promise<{ slug: CorpusSlug }> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      createCorpusCommand(ctx, input),
    );
    return outcome.result;
  }

  // Edit a corpus's name/description. The slug — and so the root folder —
  // is never touched: renaming a corpus changes no corpus-relative path.
  // ok:false only when the corpus is absent; an unchanged name+description
  // is an idempotent ok:true no-op.
  async updateCorpus(input: UpdateCorpusInput): Promise<{ ok: boolean }> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      updateCorpusCommand(ctx, input),
    );
    return { ok: outcome.result.status !== "missing" };
  }

  // Delete a corpus; `input.pages` says whether its pages are archived
  // with it or kept as drafts in the default corpus. One transaction. The
  // default corpus is refused. Revoking the credentials bound to the
  // corpus is the control plane's job and happens before this is called.
  async deleteCorpus(input: DeleteCorpusInput): Promise<DeleteCorpusResult> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      deleteCorpusCommand(ctx, input),
    );
    return outcome.result;
  }

  // The agent-facing view of a corpus: its documents in path order, with
  // corpus-relative paths and resolved links — the whole hierarchy + link
  // graph in one read. Canonical bytes are never rewritten; links are
  // resolved here against the current path map.
  async corpusOutline(corpusSlug: CorpusSlug): Promise<CorpusOutline> {
    return corpusOutlineProjection(
      await this.read(),
      corpusSlug,
      this.parsedLinksByHash,
    );
  }

  // Cut a fresh immutable CorpusVersion from what is under the corpus root
  // right now. The single place a snapshot is taken — every path that
  // changes which documents a corpus holds (create, archive, a move across
  // corpora, folder delete) routes through here.
  private async snapshotCorpus(
    u: Unit,
    corpusSlug: CorpusSlug,
    changedBy: string,
    now: string,
  ): Promise<void> {
    const colNode = await u.cols.findCorpus(corpusSlug);
    const views = await resolvedViews(u, corpusSlug);
    if (colNode === undefined || views === undefined) return;
    const nextColVersion =
      (await u.versions.latestCollectionVersion(corpusSlug)) + 1;
    await u.versions.appendCollectionVersion(
      colNode.id,
      collectionVersionSnapshot({
        collectionSlug: corpusSlug,
        collectionVersion: nextColVersion,
        members: corpusSnapshotMembers(views),
        changedAt: now,
        changedBy,
      }),
    );
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

  // — Folders and moves ————————————————————————————————————————————
  //
  // Authoring-plane organization (single-parent tree) inside a corpus.
  // Mutations are web / server-fn only (MCP stays read-only). Every
  // destination is a `CorpusLocation` — a corpus and optionally a folder of
  // it — never "the project root": the corpus roots themselves cannot be
  // seen, renamed, moved or deleted. Moving a folder or a document to
  // another corpus is the same tree move as moving it within one, and
  // everything attached to a document travels because nothing but an edge
  // changes; such a move is recorded on both corpora.

  async createFolder(
    name: string,
    location: CorpusLocation,
  ): Promise<CreateFolderResult> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      createFolderCommand(ctx, { name, location }),
    );
    return outcome.result;
  }

  async renameFolder(
    slug: FolderSlug,
    name: string,
    changedBy: string,
  ): Promise<RenameFolderResult> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      renameFolderCommand(ctx, { slug, name, changedBy }),
    );
    return outcome.result;
  }

  async moveFolder(
    slug: FolderSlug,
    destination: CorpusLocation,
    changedBy: string,
  ): Promise<MoveFolderResult> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      moveFolderCommand(ctx, { slug, destination, changedBy }),
    );
    return outcome.result;
  }

  // Cascade: the folder's documents are archived, its subfolders removed.
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

  // Moving a page out of the default corpus into a named corpus is what
  // publishes it; moving it back unpublishes it.
  async moveDocument(
    documentSlug: DocumentSlug,
    destination: CorpusLocation,
    changedBy: string,
  ): Promise<PlaceDocumentResult> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      moveDocumentCommand(ctx, { documentSlug, destination, changedBy }),
    );
    return outcome.result;
  }

  // Bulk move into one place, best-effort in a single tx: the documents
  // that can move do, and the rest (a filename collision) are counted.
  async moveDocuments(
    documentSlugs: readonly DocumentSlug[],
    destination: CorpusLocation,
    changedBy: string,
  ): Promise<MoveDocumentsResult> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      moveDocumentsCommand(ctx, { documentSlugs, destination, changedBy }),
    );
    return outcome.result;
  }

  // The folders people see, each tagged with its corpus; roots are hidden.
  async listFolders(): Promise<readonly CorpusFolderView[]> {
    return listFoldersProjection(await this.read());
  }

  // Bulk upload, ONE document at a time, into one corpus. The whole
  // per-document import — ensure ancestor folders under the corpus root →
  // resolve/reuse slug → append a DocumentVersion, placed in its folder —
  // is a single atomic `write()`. A tree upload is N of these (bounded
  // per-document atomicity, never one giant tx). Idempotent on the
  // corpus-relative path: a re-upload resolves to the existing document at
  // that path and bumps its version; a fresh path mints a stable,
  // collision-suffixed slug. A folder/document segment collision throws
  // ImportAbort → the whole unit rolls back (nothing partially written).
  async importDocumentAtPath(
    input: Readonly<{
      corpusSlug: CorpusSlug;
      path: string;
      markdown: string;
      changedBy: string;
    }>,
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

  // The corpus an upload lands in, materialized before the first file: the
  // default corpus, an existing one (`undefined` when it is gone), or a
  // new one named by the uploader.
  private async importDestination(
    input: ImportIntoCorpusInput,
  ): Promise<CorpusSlug | undefined> {
    const now = new Date().toISOString();
    const { destination, changedBy } = input;
    const outcome = await this.writeCommand<CorpusSlug | undefined>(
      now,
      async (ctx) => {
        if (destination.mode === "default") {
          const ensured = await ensureDefaultCorpusCommand(ctx, changedBy);
          return { result: DEFAULT_CORPUS_SLUG, changes: ensured.changes };
        }
        if (destination.mode === "existing") {
          const exists =
            (await ctx.u.cols.rootFolderSlug(destination.slug)) !== undefined;
          return {
            result: exists ? destination.slug : undefined,
            changes: [],
          };
        }
        const created = await createCorpusCommand(ctx, {
          slug: asCorpusSlug(slugify(destination.name)),
          name: destination.name,
          changedBy,
        });
        return { result: created.result.slug, changes: created.changes };
      },
    );
    return outcome.result;
  }

  // Drive a whole tree upload into one corpus: N independent atomic
  // imports (one write() each — never one giant tx), in the given order so
  // ancestor folders are reused as they appear, then one snapshot of the
  // corpus. Uploaded paths are relative to the corpus root.
  async importIntoCorpus(
    input: ImportIntoCorpusInput,
  ): Promise<ImportIntoCorpusResult | undefined> {
    // Refuse the whole upload before anything is written: one escaping path
    // must not leave the files before it committed.
    for (const entry of input.entries) checkedPathSegments(entry.path);
    const corpusSlug = await this.importDestination(input);
    if (corpusSlug === undefined) return undefined;
    let created = 0;
    let updated = 0;
    const failed: { path: string; reason: string }[] = [];
    for (const entry of input.entries) {
      const r = await this.importDocumentAtPath({
        corpusSlug,
        path: entry.path,
        markdown: entry.markdown,
        changedBy: input.changedBy,
      });
      if (!r.ok) failed.push({ path: entry.path, reason: r.reason });
      else if (r.created) created += 1;
      else updated += 1;
    }
    if (created > 0) {
      const now = new Date().toISOString();
      await this.writeCommand(now, async (ctx) => ({
        result: undefined,
        changes: await corpusTreeChanged(
          ctx,
          [corpusSlug],
          input.changedBy,
          "membership",
        ),
      }));
    }
    const summary: ImportSummary = { created, updated, failed };
    return { summary, corpusSlug };
  }

  // The example project (`src/sample-project.ts`): a company corpus and a
  // team corpus, each holding its own pages — knowledge reaches two
  // audiences by an agent connecting to both corpora, never by one page
  // sitting in two. One atomic tx over all writes, so a partial seed is
  // impossible. No-op if the project already has any document or any
  // corpus besides the default one, so a double-click on a populated
  // project never errors on a brand-new user's first action.
  async seedExample(changedBy: string): Promise<SeedResult> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      seedExampleCommand(ctx, changedBy),
    );
    return outcome.result;
  }

  // Materialize the default corpus — the drafts space — and its root on
  // first access, so a new page or an upload has somewhere to land without
  // asking the user to name a corpus. Idempotent — safe on every load.
  async ensureDefaultCorpus(
    changedBy: string,
  ): Promise<EnsureDefaultCorpusResult> {
    const now = new Date().toISOString();
    const outcome = await this.writeCommand(now, (ctx) =>
      ensureDefaultCorpusCommand(ctx, changedBy),
    );
    return outcome.result;
  }
}
