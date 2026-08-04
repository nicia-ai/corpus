import type { Logger } from "drizzle-orm/logger";

// Module-level because tests reach the graph backend through DO RPC. The
// ledger uses a separate Drizzle instance, so only graph SQL reaches this sink.
let sink: ((sql: string) => void) | undefined;

// Production never installs a sink, leaving `logQuery` as a no-op branch.
export function setGraphStatementSinkForTest(
  onStatement: (sql: string) => void,
): () => void {
  const previous = sink;
  sink = onStatement;
  return () => {
    sink = previous;
  };
}

export const graphStatementLogger: Logger = {
  logQuery(query: string): void {
    sink?.(query);
  },
};
