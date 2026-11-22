import { z } from "zod";

import { PROPOSAL_MESSAGE_MAX_LENGTH } from "../lib/proposal-message";
import { MAX_MARKDOWN_BYTES } from "../util";

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

// What an agent is told at `initialize`. A Corpus is a folder of markdown
// files; nothing is pre-assembled or pre-selected for the agent — it lists
// the folder and reads what it decides it needs.
export const SERVER_INSTRUCTIONS = [
  "This server gives you one Corpus: a folder of markdown files that a team maintains for you.",
  "Paths are relative to the Corpus root, like files in a directory (for example `README.md` or `policies/refunds.md`).",
  "Call list_documents to see every file with its path, then read_document with a path to read one. Nothing is loaded for you in advance: list first, then read what the task needs.",
  "You cannot change a file directly. Use suggest_edit to propose an edit or a new file; a person reviews it and decides.",
].join(" ");

export const CORPUS_URI = "corpus://";
// Pre-rename scheme: still accepted on read, never advertised.
export const LEGACY_COLLECTION_URI = "collection://";
export const DOCUMENT_URI = "document://";
export const OUTLINE_SUFFIX = "/outline";

// Pre-rename tool names, still callable, never listed in TOOLS.
export const LEGACY_TOOL_ALIASES: Readonly<Record<string, string>> = {
  list_collections: "list_corpora",
};

export const TOOLS = [
  {
    name: "list_corpora",
    description:
      "Describe the Corpus this connection is bound to (a connection targets exactly one): its slug, name and description.",
  },
  {
    name: "list_documents",
    description:
      "List every markdown file in the Corpus, like a directory listing: path (relative to the Corpus root), slug, title, version and size, ordered by path. Start here, then read the files the task needs.",
  },
  {
    name: "read_document",
    description:
      "Read one file's markdown, verbatim, by its Corpus path such as `docs/brand-voice.md` (or by slug). The file must be in this Corpus.",
  },
  {
    name: "read_document_meta",
    description:
      "Parsed YAML frontmatter for one file in the Corpus, by Corpus path or slug. The file itself is never altered — read_document still returns it verbatim.",
  },
  {
    name: "verify_history",
    description:
      "Verify the content-addressed version chain. Pass `documentSlug` to verify one document; omitted = verify every document in the Corpus this connection is bound to.",
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
      "Propose an edit to a file in the Corpus — or a NEW file — as a reviewable suggestion. Nothing is EVER auto-applied: a human accepts or rejects it. To edit: read the file first, then pass its Corpus `path` (or `slug`), the full `proposedMarkdown` body, and the `baseDocVersion` you read; if the file has moved on since, you get a conflict and must re-read. To propose a new file: pass a Corpus path (or slug) that doesn't exist yet with `baseDocVersion: 0` and the full body; when a human applies it, the file is created at that path in this Corpus.",
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
          maxLength: MAX_MARKDOWN_BYTES,
          description:
            "The full proposed document body, verbatim (at most 1 MB of UTF-8 markdown).",
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
