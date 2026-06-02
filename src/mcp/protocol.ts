import { z } from "zod";

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
] as const;

export function ok(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

export function err(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function textContent(text: string) {
  return { content: [{ type: "text", text }] };
}
