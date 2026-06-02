// `pnpm verify [documentSlug]` — runs the `verify_history` MCP tool
// (the same DO method the agent surface uses). Exit 0 = ok, 1 = chain
// broken, 2 = error.

import { callMcpTool, runCli } from "./_mcp";

runCli(async () => {
  const documentSlug = process.argv[2];
  const text = await callMcpTool(
    "verify_history",
    documentSlug === undefined ? {} : { documentSlug },
  );
  const result = JSON.parse(text) as
    | { ok: true }
    | { ok: false; brokenAt: unknown };
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
});
