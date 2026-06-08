import { z } from "zod";

import { asCollectionSlug, asDocumentSlug } from "../ids";
import { parseFrontmatter } from "../store/domain/frontmatter";

import type { McpExecutor } from "./executor";
import { boundCollectionSlug, documentSlugFromArgs, strField } from "./params";
import { ERR, err, ok, textContent, TOOLS } from "./protocol";

// suggest_edit args. The document is addressed by slug OR path (resolved
// via documentSlugFromArgs, like the read tools); these two fields are the
// proposal itself. Zod at MCP ingestion (AGENTS.md) — this is the first
// write tool, so it gets real validation rather than the ad-hoc strField
// the read tools use.
const SuggestEditArgs = z.object({
  proposedMarkdown: z.string(),
  baseDocVersion: z.number().int().nonnegative(),
});

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

  suggest_edit: async ({ id, exec, params }) => {
    const fields = SuggestEditArgs.safeParse(params);
    if (!fields.success) {
      return err(
        id,
        ERR.INVALID_PARAMS,
        "suggest_edit needs proposedMarkdown (string) and baseDocVersion (number)",
      );
    }
    const requested = await documentSlugFromArgs(exec, params);
    if (!requested.ok && requested.reason === "missing") {
      return err(id, ERR.INVALID_PARAMS, "suggest_edit needs slug or path");
    }
    if (!requested.ok) {
      return err(id, ERR.NOT_FOUND, `unknown document: ${requested.label}`);
    }
    const res = await exec.suggestEdit(
      exec.callerRef,
      requested.slug,
      fields.data.proposedMarkdown,
      fields.data.baseDocVersion,
    );
    if (res.ok) {
      return ok(
        id,
        textContent(
          JSON.stringify({
            suggestionId: res.suggestionId,
            hunkCount: res.hunkCount,
          }),
        ),
      );
    }
    switch (res.reason) {
      case "conflict":
        return err(
          id,
          ERR.CONFLICT,
          `document moved to version ${res.currentVersion}; re-read and re-propose against the current head`,
          { currentVersion: res.currentVersion },
        );
      case "no-change":
        return ok(
          id,
          textContent(
            JSON.stringify({
              suggestionId: null,
              hunkCount: 0,
              note: "no changes",
            }),
          ),
        );
      case "missing":
        // The doc was resolvable at slug-resolution but is gone now (or was
        // gated out by the scoped executor): same NOT_FOUND, no oracle.
        return err(id, ERR.NOT_FOUND, `unknown document: ${requested.label}`);
      default: {
        // Exhaustive: a new CreateSuggestionResult reason is a compile error
        // here, with a defensive runtime fallback if one ever slips through.
        const unexpected: never = res;
        return err(
          id,
          ERR.NOT_FOUND,
          `unexpected suggest result ${String(unexpected)}`,
        );
      }
    }
  },
};

export function toolsListResponse(id: unknown): unknown {
  return ok(id, {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: "inputSchema" in t ? t.inputSchema : { type: "object" },
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
