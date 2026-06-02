import type { Store, TransactionContext } from "@nicia-ai/typegraph";

import type { CanonicalGraph } from "../graph";

// TypeGraph's top-level store and its in-transaction context expose the
// same `nodes`/`edges` surface, so a repo can bind to either: the DO's
// write() passes the tx, read() passes the store.
export type GraphHandle =
  | Store<CanonicalGraph>
  | TransactionContext<CanonicalGraph>;
