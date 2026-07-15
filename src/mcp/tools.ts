import { z } from "zod";

import { asCollectionSlug, asDocumentSlug } from "../ids";
import { parseFrontmatter } from "../store/domain/frontmatter";
import { CREATE_PROPOSAL_BASE_VERSION } from "../store/domain/suggestion";
import { compact } from "../util";

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

const GetProposalResultArgs = z.object({
  proposalId: z.number().int().positive(),
});

// Create-proposals mint a NEW identifier, so unlike reads/edits (which
// accept whatever slug already exists) the proposed slug is format-checked
// at the boundary: the normalizeSlug alphabet — lowercase alphanumerics
// joined by single leading/trailing-free dashes.
const CREATE_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// Shared create path for suggest_edit's baseDocVersion-0 form. The scoped
// executor pins the proposal's origin to its bound Collection; `taken` is
// mapped to CONFLICT — the same existence grade the REST create path
// already exposes through its 403, so an agent can pick another name.
async function proposeCreate(
  id: unknown,
  exec: McpExecutor,
  target: Readonly<{ slug?: string; path?: string }>,
  proposedMarkdown: string,
): Promise<unknown> {
  if (proposedMarkdown.trim() === "") {
    return err(
      id,
      ERR.INVALID_PARAMS,
      "a new-document proposal needs non-empty proposedMarkdown",
    );
  }
  if (target.slug !== undefined && !CREATE_SLUG.test(target.slug)) {
    return err(
      id,
      ERR.INVALID_PARAMS,
      "not a valid new document slug (lowercase letters, digits, single dashes)",
    );
  }
  const res = await exec.suggestCreate(
    exec.callerRef,
    compact({
      slug: target.slug !== undefined ? asDocumentSlug(target.slug) : undefined,
      path: target.path,
      proposedMarkdown,
    }),
  );
  if (res.ok) {
    return ok(
      id,
      textContent(
        JSON.stringify({
          suggestionId: res.suggestionId,
          created: true,
          slug: res.slug,
          note: "new-document proposal filed; a human reviews and applies it",
        }),
      ),
    );
  }
  if (res.reason === "taken") {
    return err(
      id,
      ERR.CONFLICT,
      "that slug or path already belongs to a document; propose a different one",
    );
  }
  return err(
    id,
    ERR.INVALID_PARAMS,
    "suggest_edit with baseDocVersion 0 needs a valid new slug or Corpus path",
  );
}

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

  get_proposal_result: async ({ id, exec, params }) => {
    const fields = GetProposalResultArgs.safeParse(params);
    if (!fields.success) {
      return err(
        id,
        ERR.INVALID_PARAMS,
        "get_proposal_result needs a positive integer proposalId",
      );
    }
    const result = await exec.proposalResult(
      exec.callerRef,
      fields.data.proposalId,
    );
    return result.found
      ? ok(id, textContent(JSON.stringify(result)))
      : err(id, ERR.NOT_FOUND, "unknown proposal");
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
      // The path resolved to nothing. With baseDocVersion 0 that is a
      // NEW-document proposal; any other base version keeps the existing
      // NOT_FOUND contract.
      if (fields.data.baseDocVersion === CREATE_PROPOSAL_BASE_VERSION) {
        return proposeCreate(
          id,
          exec,
          { path: requested.label },
          fields.data.proposedMarkdown,
        );
      }
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
      case "missing": {
        // Not a member of the bound Collection (or gone). With
        // baseDocVersion 0 this is the slug form of a NEW-document
        // proposal; otherwise the same NOT_FOUND as before, no oracle. A
        // slug that exists elsewhere in the project comes back from the
        // create path as CONFLICT ("taken") — the grade of existence the
        // REST create path already exposes.
        if (fields.data.baseDocVersion === CREATE_PROPOSAL_BASE_VERSION) {
          const rawPath = strField(params, "path");
          return proposeCreate(
            id,
            exec,
            {
              slug: requested.label,
              ...(rawPath === "" ? {} : { path: rawPath }),
            },
            fields.data.proposedMarkdown,
          );
        }
        return err(id, ERR.NOT_FOUND, `unknown document: ${requested.label}`);
      }
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
