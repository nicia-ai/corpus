import { asCorpusSlug, asDocumentSlug } from "../ids";

import type { McpExecutor } from "./executor";
import { strField } from "./params";
import {
  CORPUS_URI,
  DOCUMENT_URI,
  ERR,
  LEGACY_COLLECTION_URI,
  OUTLINE_SUFFIX,
  err,
  ok,
} from "./protocol";

export async function listResources(
  id: unknown,
  exec: McpExecutor,
): Promise<unknown> {
  const [corpora, documents] = await Promise.all([
    exec.listCorpora(),
    exec.listDocuments(),
  ]);
  return ok(id, {
    resources: [
      ...corpora.map((c) => ({
        uri: `${CORPUS_URI}${c.slug}${OUTLINE_SUFFIX}`,
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
  const scheme = [CORPUS_URI, LEGACY_COLLECTION_URI].find((s) =>
    uri.startsWith(s),
  );
  if (scheme !== undefined && uri.endsWith(OUTLINE_SUFFIX)) {
    const slug = asCorpusSlug(
      uri.slice(scheme.length, uri.length - OUTLINE_SUFFIX.length),
    );
    const o = await exec.corpusOutline(slug);
    if (!o.found) return err(id, ERR.NOT_FOUND, `unknown corpus: ${uri}`);
    return ok(id, {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({
            corpus: o.corpus,
            collection: o.corpus,
            name: o.name,
            documents: o.documents,
          }),
        },
      ],
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
