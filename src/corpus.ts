import { estimateTokens } from "./util";

export type CorpusDocument = Readonly<{
  slug: string;
  title: string;
  docVersion: number;
  updatedAt: string;
  markdown: string;
}>;

export type CorpusManifestEntry = Readonly<{
  slug: string;
  docVersion: number;
  updatedAt: string;
  size: number;
}>;

export type AssembledCorpus = Readonly<{
  corpus: string;
  documents: readonly CorpusManifestEntry[];
}>;

// Position-ordered markdown corpus for an agent corpus plus a
// provenance manifest. Pure: the caller resolves the graph and supplies
// docs already in attach order — this only renders, so it is
// unit-testable without a DO.
export function assembleCorpus(
  corpusSlug: string,
  ordered: readonly CorpusDocument[],
): AssembledCorpus {
  const manifest: CorpusManifestEntry[] = ordered.map((d) => ({
    slug: d.slug,
    docVersion: d.docVersion,
    updatedAt: d.updatedAt,
    size: estimateTokens(d.markdown),
  }));

  if (ordered.length === 0) {
    return {
      documents: [],
      corpus: `# Corpus: ${corpusSlug}\n(no documents in this corpus)\n`,
    };
  }

  const header = [
    `# Corpus: ${corpusSlug}`,
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
