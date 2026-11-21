// A Durable Object's SQLite allows 100 bound parameters per statement. Any
// read or write that binds one parameter per id (`IN (...)`) goes through
// here so it stays under the ceiling however large the set grows. Callers
// whose statements bind several parameters per item pass a smaller size.
export const SQL_PARAMETER_LIMIT = 100;

export function inBatches<T>(
  items: readonly T[],
  size: number = SQL_PARAMETER_LIMIT,
): readonly (readonly T[])[] {
  const batches: (readonly T[])[] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

// Runs `read` once per batch and concatenates the rows in batch order.
// Callers that need a global ordering re-sort the result.
export async function readInBatches<T, R>(
  items: readonly T[],
  read: (batch: readonly T[]) => Promise<readonly R[]>,
  size: number = SQL_PARAMETER_LIMIT,
): Promise<readonly R[]> {
  const rows = await Promise.all(inBatches(items, size).map(read));
  return rows.flat();
}
