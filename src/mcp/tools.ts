import { asCollectionSlug, asDocumentSlug } from "../ids";
import { parseFrontmatter } from "../store/domain/frontmatter";

import type { McpExecutor } from "./executor";
import { boundCollectionSlug, documentSlugFromArgs, strField } from "./params";
import { ERR, err, ok, textContent, TOOLS } from "./protocol";

type ToolHandler = (args: {
  id: unknown;
  exec: McpExecutor;
  params: Record<string, unknown>;
}) => Promise<unknown>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  list_collections: async ({ id, exec }) =>
    ok(id, textContent(JSON.stringify(await exec.listCollections()))),

  list_documents: async ({ id, exec }) =>
    ok(id, textContent(JSON.stringify(await exec.listDocuments()))),

  read_collection: async ({ id, exec, params }) => {
    const rawSlug = strField(params, "collectionSlug");
    const slug =
      rawSlug === ""
        ? await boundCollectionSlug(exec)
        : asCollectionSlug(rawSlug);
    if (slug === undefined) {
      return err(id, ERR.NOT_FOUND, "no bound collection");
    }
    const r = await exec.readCollection(slug);
    if (!r.found) return err(id, ERR.NOT_FOUND, `unknown collection: ${slug}`);
    return ok(id, textContent(r.corpus));
  },

  read_document: async ({ id, exec, params }) => {
    const requested = await documentSlugFromArgs(exec, params);
    if (!requested.ok && requested.reason === "missing") {
      return err(id, ERR.INVALID_PARAMS, "read_document needs slug or path");
    }
    if (!requested.ok) {
      return err(id, ERR.NOT_FOUND, `unknown document: ${requested.label}`);
    }
    const d = await exec.getDocument(requested.slug);
    if (d === undefined) {
      return err(id, ERR.NOT_FOUND, `unknown document: ${requested.label}`);
    }
    return ok(id, textContent(d.markdown));
  },

  read_document_meta: async ({ id, exec, params }) => {
    const requested = await documentSlugFromArgs(exec, params);
    if (!requested.ok && requested.reason === "missing") {
      return err(
        id,
        ERR.INVALID_PARAMS,
        "read_document_meta needs slug or path",
      );
    }
    if (!requested.ok) {
      return err(id, ERR.NOT_FOUND, `unknown document: ${requested.label}`);
    }
    const d = await exec.getDocument(requested.slug);
    if (d === undefined) {
      return err(id, ERR.NOT_FOUND, `unknown document: ${requested.label}`);
    }
    const fm = parseFrontmatter(d.markdown);
    if (!fm.ok) {
      return err(id, ERR.INVALID_PARAMS, `invalid frontmatter: ${fm.error}`);
    }
    return ok(
      id,
      textContent(
        JSON.stringify({
          slug: d.slug,
          hasFrontmatter: fm.frontmatter !== undefined,
          frontmatter: fm.frontmatter ?? null,
        }),
      ),
    );
  },

  verify_history: async ({ id, exec, params }) => {
    const raw = strField(params, "documentSlug");
    const result = await exec.verifyHistory(
      raw === "" ? undefined : asDocumentSlug(raw),
    );
    return ok(id, textContent(JSON.stringify(result)));
  },
};

export function toolsListResponse(id: unknown): unknown {
  return ok(id, {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: "object" },
    })),
  });
}

export async function handleToolCall(
  id: unknown,
  params: Record<string, unknown>,
  exec: McpExecutor,
): Promise<unknown> {
  const name = params.name;
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const handler = typeof name === "string" ? TOOL_HANDLERS[name] : undefined;
  return handler === undefined
    ? err(id, ERR.METHOD_NOT_FOUND, `unknown tool: ${String(name)}`)
    : handler({ id, exec, params: args });
}
