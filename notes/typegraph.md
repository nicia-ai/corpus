# TypeGraph notes

Background for the TypeGraph rules in `AGENTS.md`. Rules live there; the
evidence, measurements, and upgrade history live here. Nothing in this
file is a standard — if a line here reads like an instruction, it belongs
in `AGENTS.md` instead.

## Why `ensureStore` self-heals (the 0.50 incident)

0.50 added claim relations (`typegraph_node_uniques` axis rework,
`typegraph_edge_claims`, a `disjointWith` claim) that fence uniqueness /
disjointness / edge cardinality with a real row instead of racing the
per-graph advisory lock. Bundled SQLite declares `constraintClaims: true`.

This was wrongly believed to bootstrap for free — "no manual DO migration
needed, confirmed by the full suite passing straight through the
0.49→0.52 bump". Every test builds a _fresh_ store, which takes
`ensureSchema`'s `initializeSchema` path (no stored schema to diff
against) and never exercises an _existing_ project's DO. Against real
data the change registers as a modified (not added) node,
`isBackwardsCompatible` calls that breaking, and `ensureSchema` throws
`MigrationError`. Every existing project 500'd on next open.

The fix was `ProjectStore.migrateGraphSchemaIfNeeded`, called from
`ensureStore` before `createAdapterStoreWithSchema`: on a breaking diff
it calls `migrateSchema()` itself. There is no per-project migration
mechanism other than the DO's own next boot — no
`wrangler d1 migrations apply` equivalent exists for a graph scattered
across one DO per project — so `ensureStore` has to be able to self-heal,
not just bootstrap. `migrateSchema`'s own kind-removal guard (refuses to
drop a populated kind) is unaffected; this only forecloses the
human-review step for changes TypeGraph would otherwise apply outright.

`test/graph-schema-upgrade.test.ts` is the keeper. It provisions a DO's
storage with the previous release (the `typegraph-prev` npm alias) inside
`runInDurableObject`, seeds a real claimed + fulltext-projected
`Document`, then reopens that storage through the real `ensureStore` and
writes against it.

## Base storage versioning (0.53)

0.53 versions TypeGraph's deployment-wide base storage separately from
per-graph schemas, in a `typegraph_base_schema_versions` marker table.
Zero-DDL verified stores and graph-template APIs throw
`BaseSchemaMigrationError` until a database is stamped at version 1.

Corpus is unaffected by construction: it opens through the privileged
`createAdapterStoreWithSchema`, whose `ensureSchema` adopts and stamps
the marker on first boot. Verified against a 0.52-provisioned DO — the
marker table is absent before the first 0.53 boot and present after, so
the adoption really runs and is not a no-op. This is a second reason
`ensureStore` must stay the single entry to a project's graph: a
least-privilege open would now fail instead of self-healing.

## Why the atomic-write releases don't speed Corpus up

0.53's headline is a large write-path reduction (atomic mutation programs
collapsing the old 5–6-exchange managed write). Corpus gets none of it,
by design: those fast paths are for root, non-transaction-scoped calls,
and every Corpus write rides `ProjectStore.write()`'s single enlisted
`store.transaction()`, which the release explicitly keeps on the
interactive path.

Measured with `setGraphStatementSinkForTest` across the 0.52→0.53 hop:
create-document 18, update-document 16, create-corpus 14,
list-documents 10 statements — identical on both releases.

## Why the data plane is a DO and not D1

0.46 refuses a constrained write it cannot fence
(`CONSTRAINT_WRITE_FENCE_UNSUPPORTED`) on a backend without transactions
— D1, `neon-http`, `transactionMode: "none"`. Durable Object SQLite
declares interactive transactions and fences normally, so Corpus's
`scope: "kind"` uniques are unaffected. A move to D1 would break every
unique constraint in `canonicalGraph`.

0.53 removed the top-level `capabilities.transactions` override and now
refuses it rather than ignoring it; the live field is
`capabilities.execution.interactiveTransactions`. Corpus passes no
capability override, so nothing to change — but do not reintroduce the
old spelling from an older doc or example.

## Diagnostics deliberately kept off the boot path

Each of these is a real API that solves a real problem Corpus does not
have. Run them by hand against a suspect database; do not wire them into
`ensureStore` without revisiting the trade.

- `probeContributions()` — the FTS5 storage behind `searchable()` is
  provisioned by TypeGraph and attested by a durable marker. If the two
  drift apart (storage dropped under a live marker, or a table left at a
  shape the current `createDdl` no longer produces) the projection goes
  `degraded`, which is not a search-only
  outage: every Document write syncs the index, so save / rename / import
  fail too. Since 0.49 both paths throw `ContributionUnavailableError`
  with `state: "physical-storage-missing"`, the driver error kept as
  `cause`, and `getErrorSuggestion()` naming the remedy —
  `store.rebuildContribution("fulltext")`, which drops, recreates, and
  repopulates the index from the nodes' `searchText`. A failed write
  still rolls back, so nothing is half-committed (verified on 0.49.0).
  Because the error diagnoses and fixes itself, a probe would cost a
  catalog read on every cold start for a state nothing here can cause.
- `verifyConstraintFences()` (0.50) — read-only audit for pre-fence
  violations already sitting in a graph. Relevant only to a pre-0.50
  database.
- `repairInvertedValidityWindows()` (0.48) — Corpus is structurally
  immune to the valid-time hazards it guards: no path states `validFrom`
  / `validTo` / `clearValidTo`, and every removal is `hardDelete`, so
  there are no tombstones to resurrect and no window a write could
  invert. `{ mode: "report" }` confirms it — 0 rows on both `live` and
  `live-and-recorded`, `atomic: true` on DO SQLite. Re-check only if a
  future path starts stating windows.
- `describe()` / `validateStore()` (0.54) — current-state diagnostics
  (per-kind population, declared-schema violations).

## Upstream gaps being tracked

- **No `bulkHardDelete`** (still absent as of 0.64). The store surface's
  `bulkDelete` is **soft** — a different operation. Do not "fix"
  `VersionRepo.reapDocumentVersions` or `FolderRepo`'s subtree loop with it.
- **`neighbors()` node typing** (0.59). `NeighborResult.node` is
  `Node<AllNodeTypes<G>>`, not the kind-discriminated `AnyNode<G>`, so
  `hit.node.kind === "Document"` does not expose `slug`. Corpus hydrates
  a known adjacent kind through `query().traverse().to()` instead.
  `select()` of `ctx.e.id` is also a plain `string`, so mutation paths
  that need a branded `EdgeId` keep `findFrom` / `findTo`.

## Per-release evaluations

- **0.38** — default `Store` / `TransactionContext` became portable and
  withhold the native handle; only `createAdapterStoreWithSchema` +
  `AdapterStore` / `AdapterTransactionContext` expose `tx.sql`. The old
  `/sqlite` entrypoint was removed, not deprecated.
- **0.39** — non-available `sqlAvailability` arms omit `sql` entirely, so
  narrowing is what makes `tx.sql` reachable at all. Also: TypeGraph
  tolerates DO SQLite's `SQLITE_AUTH` rejection of the performance-only
  `PRAGMA analysis_limit` and proceeds with scoped `ANALYZE`, so
  `refreshStatistics: false` is no longer needed on `materializeIndexes`.
- **0.44** — `bulkFindFrom` / `bulkFindTo` widen `from_id = ?` to
  `from_id IN (…)`. A backend without `findEdgesByEndpointSet` throws
  rather than silently looping.
- **0.53** — first release upgraded with the previous-release test in
  place. Reported upstream at the time: the npm tarball shipped no
  CHANGELOG (fixed in 0.54), the base-schema upgrade note read as an
  action item for users already on the privileged path, and the
  highlights did not say that transaction-scoped applications see no
  change (both clarified in 0.54).
- **0.54** — near-no-op for Corpus. Its themes (graph-scoped annotations,
  runtime-kind tokens for extension kinds, `planCandidateWriteSet()`)
  serve runtime-evolved schemas; `canonicalGraph` is static and
  compile-time. Its one upgrade note
  (`BulkOperationHookContext["operation"]` gains `"compareAndSet"`) is
  inert: Corpus registers no TypeGraph hooks. `compareAndSet()` is not
  the OCC mechanism to switch to — see `AGENTS.md`.
- **0.55** — source-dependent edge `to` maps and explicit
  `validFrom: null`. Corpus edges are already single-pair kinds
  (`includes` Collection→Document, `includes_folder` Collection→Folder,
  etc.), so the Cartesian-product problem the map solves does not
  appear; collapsing those into one kind would be a schema redesign, not
  a free upgrade win. Corpus still never states validity windows — the
  `validFrom: null` path stays unused (same posture as
  `repairInvertedValidityWindows` above). `StaleVersionError` on
  concurrent identity-repair vs schema migration is covered by staying
  on `ensureStore`.
- **0.56** — durable candidate write-set review
  (`planCandidateWriteSetReview` /
  `revalidateCandidateWriteSetReview` in `@nicia-ai/typegraph/graph-merge`)
  plus `beforeApply` / `afterApply` on reviewed plan apply, and
  `tx.getEdgeCollectionOrThrow(kind)` for generic edge dispatch. Corpus
  has no `tx.edges[kind]` casts, so the lookup migration is a no-op.
  Candidate review is the interesting surface for agent proposals
  (digest-checked evidence, compatible / changed / incompatible
  revalidation, fence + app writes in one tx) — but today's
  `suggest_edit` path is markdown hunk review over `prose-diff`, not a
  graph merge write-set, and the ledger-enlisted `ProjectStore.write()`
  already owns apply atomicity. Tracked as a possible future redesign
  of proposal apply, not adopted on this bump.
- **0.57** — backend contract (`createSqlBackend` + engine profiles),
  `TransactionConflictError`, and an optional `typegraph_fences` row
  lock. Corpus passes no capability override and DO SQLite is
  engine-serialized, so the fences table is not required; `ensureStore`
  still adopts base storage on boot. `Store.clear()` now rotates the
  revision-origin nonce — Corpus `purge()` uses `storage.deleteAll()`,
  not `store.clear()`, so the token-reuse fix is inert here.
  `applyMergePlanInTransaction` is 0.61; 0.57's merge-retry `cause`
  nesting does not apply. Ruled out: `retry: { attempts }` on
  `store.transaction()` — Corpus writes are already single-flighted by
  the DO.
- **0.58** — `bulkFindEdgesTo` (cross-kind inbound) and
  `executeChecked`. Corpus always knows the edge kind, so per-kind
  `bulkFindTo` remains the call. `canonicalGraph` is static; a
  schema-version check on every read would add a predicate Corpus
  cannot violate mid-request. Whole-node `select()` now plans a full
  fetch up front (no extra statement on a fresh query instance) — that
  is why folder/document hydrations can `select((ctx) => ctx.child)`
  without a follow-up load.
- **0.59** — `batchOnce`, `neighbors`, `countNeighbors`, per-edge-kind
  `subgraph` windows, `withCheckedReads`. Adopted: `batchOnce` of fluent
  queries for corpus membership (`ordered` / `entries`) so the corpus
  lookup and both membership kinds share one statement. Ruled out:
  `neighbors()` for kind-narrowed hydrations (see gap above);
  `withCheckedReads` (same reason as `executeChecked`); `subgraph()`
  for folder trees (`edgeWindows.limit` is required, so an unbounded
  child set cannot be expressed).
- **0.60** — the 0.59 read APIs land on `TransactionContext`. This is
  the hop that made `GraphHandle.query()` / `batchOnce()` legal inside
  `ProjectStore.write()`, not just `read()`. No new Corpus surface
  beyond unlocking those calls on the union.
- **0.61** — query DSL as SQL result shaping: `project()`, `count()`,
  `exists()`, selected-query `first()`, `expr.collect()`, completed-
  match `where()`, multi-kind `from([...])`, directed node index keys,
  `applyMergePlanInTransaction`, `requestRecordedRevision`. Adopted:
  `count()` / `first()` for version aggregates and usage snapshot
  (replacing hydrate-then-length / hydrate-then-max); `project()` for
  corpus membership DTOs; `optionalTraverse` for root-folder /
  root-document scans and `listFolders`; recursive `folder_child` for
  ancestor chains, subtree folder sets, and `liveDocumentPaths`
  (pathIndex is one statement instead of per-doc `documentFolder` +
  per-folder ancestor walks). Ruled out: directed `keys` indexes
  (SQLite already scans `(slug, docVersion)` both ways; `keys` cannot
  back `bulkFindByIndex`); `expr.collect()` (neighbors/project already
  return typed rows); `from(["Document","Folder"])` for the sibling
  namespace (shared fields are not the collision key — `name` vs
  `filename`); merge-plan-in-transaction and recorded checkpoints
  (Corpus has no graph-merge apply path and does not enable
  `history: true`). `shareSubgraphs` is opt-in and needs overlapping
  payload-heavy roots — Corpus subgraphs are disjoint folder trees.
- **0.62** — `planEvolution()` / `withEvolvedTransaction()` /
  `refreshSchema()`, plus `branchForEvolution` /
  `planMergeForEvolution` so a schema change, graph writes, recorded
  history, and application SQL can share one caller-owned transaction.
  Corpus does not evolve `canonicalGraph` at runtime and does not merge
  graphs, so none of this is a boot or write-path change. Bundled
  SQLite stays `schemaProvisioning: "dml-only"` (identity/vector DDL
  inside an adopted tx is refused, which Corpus never requests).
  `ensureStore` remains the only graph entry; do not route schema
  adoption through `withEvolvedTransaction()`. `SchemaFenceTimeoutError`
  and `refreshSchema({ ref, minVersion })` are for that evolution
  handshake, not for `createAdapterStoreWithSchema`. No Corpus mocks
  implement `StoreEvolution` or `AdapterBackend` by hand, so the new
  required members (`planEvolution`, `refreshSchema`,
  `schemaProvisioning`) are inert. Same posture as 0.54: a runtime-
  evolved-schema release against a compile-time graph.
- **0.63** — `relation.topPerPartition()` (windowed top-N per parent) and
  `expr.collect({ field }, { orderBy, filter })` (ordered record arrays).
  Adopted: `latestCollectionVersions` now ranks one row per
  `collectionSlug` in SQL instead of hydrating every snapshot and
  reducing in memory. Ruled out: record `collect()` for corpus membership
  or folder children — `batchOnce` + `project()` already returns typed
  rows, and `collect` needs `orderedAggregates` (probed, not guaranteed
  on DO SQLite). Custom dialect `orderedRecordJsonArray` is inert; Corpus
  uses the bundled SQLite adapter.
- **0.64** — query-backed `updateWhere({ candidates })`, transaction
  `describe()` / `validateStore()`, deployment-scoped full-text
  materialization, and the `endpointSetRead` capability for bulk
  endpoint reads. Corpus already opens through
  `createAdapterStoreWithSchema`, which attests the deployment-scoped
  FTS table and activates this graph — `createStore()` would not. No
  `updateWhere` path: search backfill writes a distinct `searchText` per
  document, and archive is per-node so change events can name the slug.
  `describe()` / `validateStore()` stay off the boot path (same as
  0.54). Bundled SQLite already supports `bulkFindFrom` / `bulkFindTo`;
  the new capability is a custom-backend contract, not an app change.
