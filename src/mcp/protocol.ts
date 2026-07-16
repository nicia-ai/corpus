import { z } from "zod";

import { PROPOSAL_MESSAGE_MAX_LENGTH } from "../lib/proposal-message";

export const RpcSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.unknown().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
});
export type Rpc = Readonly<z.infer<typeof RpcSchema>>;

export const ERR = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  NOT_FOUND: -32004,
  // The agent proposed against a version that is no longer head. The
  // `data.currentVersion` field tells it what to re-read before re-proposing.
  CONFLICT: -32009,
} as const;

export const COLLECTION_URI = "collection://";
export const DOCUMENT_URI = "document://";
export const OUTLINE_SUFFIX = "/outline";

export const TOOLS = [
  {
    name: "list_collections",
    description:
      "List the Collection this connection is bound to (a connection targets exactly one).",
  },
  {
    name: "read_collection",
    description:
      "Read the core guidance for the Collection this connection is bound to. No arguments are needed; a collectionSlug may be passed only if it is this connection's bound Collection. Reference documents remain available through the outline and read_document.",
  },
  {
    name: "list_documents",
    description:
      "List the documents in the Collection this connection is bound to (path, slug, title, version, size, delivery). Use path for user-facing references and slug for stable internal reads.",
  },
  {
    name: "read_document",
    description:
      "Read one document's markdown, verbatim, by slug or by Corpus path such as `docs/brand-voice.md` / `./docs/brand-voice.md`. The document must be in the bound Collection.",
  },
  {
    name: "read_document_meta",
    description:
      "Parsed YAML frontmatter for one document in the bound Collection, by slug or Corpus path. The file itself is never altered — read_document still returns it verbatim.",
  },
  {
    name: "verify_history",
    description:
      "Verify the content-addressed version chain. Pass `documentSlug` to verify one document; omitted = verify every document in the Collection this connection is bound to.",
  },
  {
    name: "get_proposal_result",
    description:
      "Get the human review outcome for one proposal created by this caller identity. Returns open, applied, partially_applied, rejected, or stale; applied hunks, resulting document version, and an optional reviewer note are included when available. Other callers' proposals are never visible.",
    inputSchema: {
      type: "object",
      properties: {
        proposalId: {
          type: "integer",
          minimum: 1,
          description: "The suggestionId returned by suggest_edit.",
        },
      },
      required: ["proposalId"],
    },
  },
  {
    name: "await_proposal_review",
    description:
      "Wait briefly for a human decision or a new proposal message. Hand the reviewUrl returned by suggest_edit to the reviewer first, then call this tool. It returns as soon as the proposal settles or a message newer than afterMessageId arrives; after at most 25 seconds it returns the still-open result with timedOut:true so the caller can wait again.",
    inputSchema: {
      type: "object",
      properties: {
        proposalId: {
          type: "integer",
          minimum: 1,
          description: "The suggestionId returned by suggest_edit.",
        },
        timeoutSeconds: {
          type: "integer",
          minimum: 0,
          maximum: 25,
          default: 25,
          description:
            "How long to wait before returning an open result (0-25 seconds; default 25).",
        },
        afterMessageId: {
          type: "integer",
          minimum: 0,
          default: 0,
          description:
            "Return when a proposal message with a larger id appears. Omit or pass 0 for the first wait; on later waits pass the largest message id already seen.",
        },
      },
      required: ["proposalId"],
    },
  },
  {
    name: "reply_to_proposal",
    description:
      "Reply inside one still-open proposal created by this caller. Use get_proposal_result or await_proposal_review to read reviewer messages, then reply here or file a revised proposal with suggest_edit. This tool cannot read or write general document comments and cannot resolve reviewer feedback.",
    inputSchema: {
      type: "object",
      properties: {
        proposalId: {
          type: "integer",
          minimum: 1,
          description: "The suggestionId returned by suggest_edit.",
        },
        body: {
          type: "string",
          minLength: 1,
          maxLength: PROPOSAL_MESSAGE_MAX_LENGTH,
          description: "A concise reply to the human reviewer.",
        },
      },
      required: ["proposalId", "body"],
    },
  },
  {
    name: "suggest_edit",
    description:
      "Propose an edit to a document in the bound Collection — or a NEW document — as a reviewable suggestion. Nothing is EVER auto-applied: a human accepts or rejects it. To edit: read the document first, then pass its `slug` (or Corpus `path`), the full `proposedMarkdown` body, and the `baseDocVersion` you read; if the document has moved on since, you get a conflict and must re-read. To propose a new document: pass a slug or Corpus path that doesn't exist yet with `baseDocVersion: 0` and the full body; when a human applies it, the document is created and joins this Collection.",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description:
            "Document slug (or use `path`). A slug that doesn't exist yet, with baseDocVersion 0, proposes a new document.",
        },
        path: {
          type: "string",
          description:
            "Corpus path such as `docs/brand-voice.md` (alternative to `slug`). A path that doesn't exist yet, with baseDocVersion 0, proposes a new document at that path.",
        },
        proposedMarkdown: {
          type: "string",
          description: "The full proposed document body, verbatim.",
        },
        baseDocVersion: {
          type: "integer",
          minimum: 0,
          description:
            "The docVersion you read; must still be head or you get a conflict. Pass 0 with a new slug/path to propose creating a document.",
        },
      },
      required: ["proposedMarkdown", "baseDocVersion"],
    },
  },
] as const;

export function ok(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

export function err(
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
) {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

export function textContent(text: string) {
  return { content: [{ type: "text", text }] };
}
