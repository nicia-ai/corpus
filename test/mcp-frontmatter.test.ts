import { describe, expect, it } from "vitest";

import { asCallerRef } from "../src/ids";
import { handleMcp, type McpExecutor, RpcSchema } from "../src/mcp";

// handleMcp depends only on the narrow McpExecutor port, so the
// frontmatter lens is unit-testable with a stub — no DO, no auth.
const DOC_WITH_FM =
  "---\ntitle: Runbook\nowner: ops\ntags:\n  - oncall\n---\n# Runbook\n\nsteps\n";
const DOC_PLAIN = "# Plain\n\nno fence here\n";

function executor(): McpExecutor {
  const docs: Record<string, string> = {
    runbook: DOC_WITH_FM,
    plain: DOC_PLAIN,
  };
  const unused = () => {
    throw new Error("not exercised in this test");
  };
  return {
    callerRef: asCallerRef("apikey:test"),
    recordRead: () => Promise.resolve(),
    listCollections: unused,
    listDocuments: unused,
    readCollection: unused,
    collectionMembers: unused,
    verifyHistory: unused,
    collectionOutline: unused,
    getDocument: (slug) => {
      const markdown = docs[slug as unknown as string];
      return Promise.resolve(
        markdown === undefined
          ? undefined
          : {
              slug: slug as unknown as string,
              title: "t",
              markdown,
              docVersion: 1,
            },
      );
    },
  };
}

function call(name: string, args: Record<string, unknown>) {
  const rpc = RpcSchema.parse({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return handleMcp(rpc, executor());
}

function resultJson(res: unknown): unknown {
  const text = (res as { result: { content: { text: string }[] } }).result
    .content[0].text;
  return JSON.parse(text);
}

describe("read_document_meta MCP tool", () => {
  it("is advertised in tools/list", async () => {
    const res = (await handleMcp(
      RpcSchema.parse({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      executor(),
    )) as { result: { tools: { name: string }[] } };
    expect(res.result.tools.map((t) => t.name)).toContain("read_document_meta");
  });

  it("returns the parsed mapping for a document with frontmatter", async () => {
    expect(
      resultJson(await call("read_document_meta", { slug: "runbook" })),
    ).toEqual({
      slug: "runbook",
      hasFrontmatter: true,
      frontmatter: { title: "Runbook", owner: "ops", tags: ["oncall"] },
    });
  });

  it("reports hasFrontmatter:false for a plain document", async () => {
    expect(
      resultJson(await call("read_document_meta", { slug: "plain" })),
    ).toEqual({ slug: "plain", hasFrontmatter: false, frontmatter: null });
  });

  it("errors NOT_FOUND for an unknown document", async () => {
    const res = (await call("read_document_meta", { slug: "missing" })) as {
      error: { code: number };
    };
    expect(res.error.code).toBe(-32004);
  });

  it("read_document still returns the file verbatim (fence intact)", async () => {
    const res = (await call("read_document", { slug: "runbook" })) as {
      result: { content: { text: string }[] };
    };
    expect(res.result.content[0].text).toBe(DOC_WITH_FM);
  });
});
