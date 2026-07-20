import type {
  AdapterStore,
  AdapterTransactionContext,
} from "@nicia-ai/typegraph";
import type { AnySqliteDatabase } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";

import type { CanonicalGraph } from "../graph";

// Corpus binds to TypeGraph's *adapter* surface, not the portable one: the
// DO's write() opens a single transaction spanning the graph AND the
// Drizzle ledger, which needs the native do-sqlite handle off `tx.sql`.
// The portable `Store` / `TransactionContext` deliberately withhold it.
export type CorpusStore = AdapterStore<CanonicalGraph, AnySqliteDatabase>;

export type CorpusTransaction = AdapterTransactionContext<
  CanonicalGraph,
  AnySqliteDatabase
>;

// TypeGraph's top-level store and its in-transaction context expose the
// same `nodes`/`edges` surface, so a repo can bind to either: the DO's
// write() passes the tx, read() passes the store.
export type GraphHandle = CorpusStore | CorpusTransaction;
