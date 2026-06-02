// Exhaustively page a node `find()` whose intent is the FULL matching set.
// A single `find({ limit })` silently truncates at the cap, so any
// "scan everything" caller loops here on `offset` until a short page.
//
// The destructive callers (retention reap, folder cascade delete) run inside
// `ProjectStore.write()`, so paging walks a consistent in-transaction snapshot
// and cannot skip or duplicate rows. Read-path callers (bundle export, outline)
// page over live data — still strictly better than the prior silent truncation.
//
// `find()` only exposes offset paging today; a keyset (`orderBy: "id"` + cursor)
// in TypeGraph's typed `find` would make the read-path walk snapshot-stable too.
let findPageSize = 1_000;

// Test seam: shrink the page so a test crosses the offset boundary without
// thousands of rows. Returns a restore fn. Never called in production.
export function setFindPageSizeForTest(size: number): () => void {
  const previous = findPageSize;
  findPageSize = size;
  return () => {
    findPageSize = previous;
  };
}

export async function findAll<T>(
  page: (
    window: Readonly<{ limit: number; offset: number }>,
  ) => Promise<readonly T[]>,
): Promise<T[]> {
  const size = findPageSize;
  const out: T[] = [];
  for (let offset = 0; ; offset += size) {
    const batch = await page({ limit: size, offset });
    out.push(...batch);
    if (batch.length < size) return out;
  }
}
