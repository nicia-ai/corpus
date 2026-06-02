// Minimal MCP JSON-RPC 2.0 surface for the Corpus store. Auth + project
// routing happen upstream; this file only dispatches the validated RPC
// envelope through the scoped McpExecutor port.

import type { McpExecutor } from "./mcp/executor";
import { ERR, err, ok, RpcSchema, type Rpc } from "./mcp/protocol";
import { listResources, readResource } from "./mcp/resources";
import { handleToolCall, toolsListResponse } from "./mcp/tools";

export { RpcSchema };
export type { McpExecutor, Rpc };

export function handleMcp(body: Rpc, exec: McpExecutor): Promise<unknown> {
  const { id, method } = body;
  const params = (body.params ?? {}) as Record<string, unknown>;

  const handlers: Record<string, () => unknown> = {
    initialize: () =>
      ok(id, {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "corpus", version: "0.1.0" },
        capabilities: { tools: {}, resources: {} },
      }),
    "tools/list": () => toolsListResponse(id),
    "tools/call": () => handleToolCall(id, params, exec),
    "resources/list": () => listResources(id, exec),
    "resources/read": () => readResource(id, params, exec),
  };

  const handler = method === undefined ? undefined : handlers[method];
  return Promise.resolve(
    handler === undefined
      ? err(id, ERR.METHOD_NOT_FOUND, `unknown method: ${String(method)}`)
      : handler(),
  );
}
