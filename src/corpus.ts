import { estimateTokens } from "./util";

export type CollectionDocument = Readonly<{
  slug: string;
  title: string;
  docVersion: number;
  updatedAt: string;
  markdown: string;
}>;

export type CollectionManifestEntry = Readonly<{
  slug: string;
  docVersion: number;
  updatedAt: string;
  size: number;
}>;

export type AssembledCollection = Readonly<{
  corpus: string;
  documents: readonly CollectionManifestEntry[];
}>;

// Position-ordered markdown corpus for an agent collection plus a
// provenance manifest. Pure: the caller resolves the graph and supplies
// docs already in attach order — this only renders, so it is
// unit-testable without a DO.
export function assembleCollection(
  collectionSlug: string,
  ordered: readonly CollectionDocument[],
): AssembledCollection {
  const manifest: CollectionManifestEntry[] = ordered.map((d) => ({
    slug: d.slug,
    docVersion: d.docVersion,
    updatedAt: d.updatedAt,
    size: estimateTokens(d.markdown),
  }));

  if (ordered.length === 0) {
    return {
      documents: [],
      corpus: `# Collection: ${collectionSlug}\n(no documents in this collection)\n`,
    };
  }

  const header = [
    `# Collection: ${collectionSlug}`,
    `Generated: ${new Date().toISOString()}`,
    "Documents:",
    ...manifest.map(
      (m) =>
        `- ${m.slug} v${String(m.docVersion)} (~${String(m.size)} tokens, updated ${m.updatedAt})`,
    ),
    "---",
  ].join("\n");
  const body = ordered
    .map(
      (d) =>
        `## Document: ${d.title}\nSlug: ${d.slug}\nVersion: ${String(d.docVersion)}\nUpdated: ${d.updatedAt}\n\n${d.markdown}`,
    )
    .join("\n\n");
  return { documents: manifest, corpus: `${header}\n${body}` };
}
