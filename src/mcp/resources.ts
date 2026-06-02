import { asCollectionSlug, asDocumentSlug } from "../ids";

import type { McpExecutor } from "./executor";
import { strField } from "./params";
import {
  COLLECTION_URI,
  DOCUMENT_URI,
  ERR,
  OUTLINE_SUFFIX,
  err,
  ok,
} from "./protocol";

export async function listResources(
  id: unknown,
  exec: McpExecutor,
): Promise<unknown> {
  const [collections, documents] = await Promise.all([
    exec.listCollections(),
    exec.listDocuments(),
  ]);
  return ok(id, {
    resources: [
      ...collections.map((c) => ({
        uri: `${COLLECTION_URI}${c.slug}`,
        name: c.name,
        mimeType: "text/markdown",
      })),
      ...collections.map((c) => ({
        uri: `${COLLECTION_URI}${c.slug}${OUTLINE_SUFFIX}`,
        name: `${c.name} — outline`,
        mimeType: "application/json",
      })),
      ...documents.map((d) => ({
        uri: `${DOCUMENT_URI}${d.slug}`,
        name: d.title,
        mimeType: "text/markdown",
      })),
    ],
  });
}

export async function readResource(
  id: unknown,
  params: Record<string, unknown>,
  exec: McpExecutor,
): Promise<unknown> {
  const uri = strField(params, "uri");
  if (uri.startsWith(COLLECTION_URI) && uri.endsWith(OUTLINE_SUFFIX)) {
    const slug = asCollectionSlug(
      uri.slice(COLLECTION_URI.length, uri.length - OUTLINE_SUFFIX.length),
    );
    const o = await exec.collectionOutline(slug);
    if (!o.found) return err(id, ERR.NOT_FOUND, `unknown collection: ${uri}`);
    return ok(id, {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({
            collection: o.collection,
            name: o.name,
            documents: o.documents,
          }),
        },
      ],
    });
  }
  if (uri.startsWith(COLLECTION_URI)) {
    const slug = asCollectionSlug(uri.slice(COLLECTION_URI.length));
    const r = await exec.readCollection(slug);
    if (!r.found) return err(id, ERR.NOT_FOUND, `unknown collection: ${uri}`);
    return ok(id, {
      contents: [{ uri, mimeType: "text/markdown", text: r.corpus }],
    });
  }
  if (uri.startsWith(DOCUMENT_URI)) {
    const d = await exec.getDocument(
      asDocumentSlug(uri.slice(DOCUMENT_URI.length)),
    );
    if (d === undefined) {
      return err(id, ERR.NOT_FOUND, `unknown document: ${uri}`);
    }
    return ok(id, {
      contents: [{ uri, mimeType: "text/markdown", text: d.markdown }],
    });
  }
  return err(id, ERR.INVALID_PARAMS, `unsupported uri: ${uri}`);
}
