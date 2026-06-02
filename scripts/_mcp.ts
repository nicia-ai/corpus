// Shared MCP client for the CLIs. A per-Project Durable Object is only
// reachable through the Worker, so every CLI drives the same OAuth-bearer
// MCP endpoint the agents use — the CLI and agent surface cannot drift.
//
//   MCP_URL    full /mcp URL (default: $BETTER_AUTH_URL/mcp or
//              http://localhost:8787/mcp)
//   MCP_TOKEN  OAuth bearer token for the target project (required)

type JsonRpcResponse = Readonly<{
  result?: { content?: readonly { type: string; text?: string }[] };
  error?: { code: number; message: string };
}>;

// Calls one MCP tool and returns its first text content block. Throws on
// missing token, transport failure, or a JSON-RPC error.
export async function callMcpTool(
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<string> {
  // Force the string-index type so the `??` defaults are not flagged
  // "unnecessary" by typed lint.
  const env: Record<string, string | undefined> = process.env;
  const token = env.MCP_TOKEN;
  if (token === undefined || token === "") {
    throw new Error("MCP_TOKEN is required (OAuth bearer for the project).");
  }
  const base =
    env.MCP_URL ?? `${env.BETTER_AUTH_URL ?? "http://localhost:8787"}/mcp`;

  const res = await fetch(base, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!res.ok) {
    throw new Error(`MCP request failed: HTTP ${String(res.status)}`);
  }
  const raw: unknown = await res.json();
  const body = raw as JsonRpcResponse;
  if (body.error !== undefined) {
    throw new Error(`MCP error: ${body.error.message}`);
  }
  return body.result?.content?.[0]?.text ?? "{}";
}

// Run a CLI main, exiting with its code; any throw exits 2.
export function runCli(main: () => Promise<number>): void {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    });
}
