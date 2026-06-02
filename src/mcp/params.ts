import {
  asCollectionSlug,
  asDocumentSlug,
  type CollectionSlug,
  type DocumentSlug,
} from "../ids";
import { pathSegments as pathParts } from "../store/domain/paths";

import type { McpExecutor } from "./executor";

// A malformed request can put a non-string where a slug is expected.
// String() would coerce it to "[object Object]" and silently look up a
// bogus slug, so treat non-strings as absent.
export function strField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

export function corpusPath(raw: string): string {
  const trimmed = raw.trim();
  const withoutScheme = trimmed.startsWith("corpus:")
    ? trimmed.slice("corpus:".length)
    : trimmed;
  return pathParts(withoutScheme).join("/");
}

export async function boundCollectionSlug(
  exec: McpExecutor,
): Promise<CollectionSlug | undefined> {
  const [col] = await exec.listCollections();
  return col === undefined ? undefined : asCollectionSlug(col.slug);
}

async function documentSlugForPath(
  exec: McpExecutor,
  rawPath: string,
): Promise<DocumentSlug | undefined> {
  const collectionSlug = await boundCollectionSlug(exec);
  if (collectionSlug === undefined) return undefined;
  const outline = await exec.collectionOutline(collectionSlug);
  if (!outline.found) return undefined;
  const path = corpusPath(rawPath);
  const doc = outline.documents.find((d) => corpusPath(d.path) === path);
  return doc === undefined ? undefined : asDocumentSlug(doc.slug);
}

export async function documentSlugFromArgs(
  exec: McpExecutor,
  args: Record<string, unknown>,
): Promise<
  Readonly<
    | { ok: true; slug: DocumentSlug; label: string }
    | { ok: false; reason: "missing" | "not_found"; label: string }
  >
> {
  const rawSlug = strField(args, "slug");
  if (rawSlug !== "") {
    return { ok: true, slug: asDocumentSlug(rawSlug), label: rawSlug };
  }
  const rawPath = strField(args, "path");
  if (rawPath === "") return { ok: false, reason: "missing", label: "" };
  const slug = await documentSlugForPath(exec, rawPath);
  return slug === undefined
    ? { ok: false, reason: "not_found", label: rawPath }
    : { ok: true, slug, label: rawPath };
}
