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
create-document 18, update-document 16, create-collection 14,
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

- **No `bulkHardDelete`** (still absent as of 0.54). The store surface
  exposes only a soft `bulkDelete`, so `VersionRepo.reapDocumentVersions`
  and `FolderRepo`'s subtree delete loop `hardDelete` per node/edge. 0.53
  made `bulkDelete` a single atomic exchange, which does not help a hard
  delete.

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
