import { drizzle } from "drizzle-orm/d1";

import * as schema from "./schema/index";

function build(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type ControlDb = ReturnType<typeof build>;

// Reuse the Drizzle instance per D1 binding instead of rebuilding the
// query-builder/relations graph on every middleware/handler call. Keyed
// by the binding object so it's GC'd with the isolate.
const cache = new WeakMap<D1Database, ControlDb>();

// Control plane lives in D1 (central, cross-project identity). The data
// plane (Document/Collection/ledger) is per-Project ProjectStore SQLite.
export function connectControlDb(d1: D1Database): ControlDb {
  let db = cache.get(d1);
  if (db === undefined) {
    db = build(d1);
    cache.set(d1, db);
  }
  return db;
}
