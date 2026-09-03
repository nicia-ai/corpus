import type { CorpusSlug } from "@/ids";
import type { ImportCorpusLink } from "@/project-store/contracts";

// Shared by DocumentUploader's initial link state and every fresh ingest.
// autoLinkCorpus must survive a drop reset — otherwise the UI copy
// promises a link and the submit sends `mode: "none"`.
export function importLinkForUpload(
  opts: Readonly<{
    autoLinkCorpus?: boolean | undefined;
    defaultCorpusSlug?: CorpusSlug | undefined;
  }>,
): ImportCorpusLink {
  if (opts.autoLinkCorpus === true && opts.defaultCorpusSlug !== undefined) {
    return { mode: "existing", slug: opts.defaultCorpusSlug };
  }
  return { mode: "none" };
}
