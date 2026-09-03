import { describe, expect, it } from "vitest";

import { asCorpusSlug } from "../src/ids";
import { importLinkForUpload } from "../src/lib/upload/import-link";

describe("importLinkForUpload", () => {
  const defaultSlug = asCorpusSlug("default");

  it("links to the default corpus when autoLinkCorpus is set", () => {
    expect(
      importLinkForUpload({
        autoLinkCorpus: true,
        defaultCorpusSlug: defaultSlug,
      }),
    ).toEqual({ mode: "existing", slug: defaultSlug });
  });

  it("stays none without autoLinkCorpus (fresh ingest must not silently attach)", () => {
    expect(
      importLinkForUpload({
        autoLinkCorpus: false,
        defaultCorpusSlug: defaultSlug,
      }),
    ).toEqual({ mode: "none" });
    expect(importLinkForUpload({ defaultCorpusSlug: defaultSlug })).toEqual({
      mode: "none",
    });
  });

  it("stays none when auto-link is set but no default slug is available", () => {
    expect(importLinkForUpload({ autoLinkCorpus: true })).toEqual({
      mode: "none",
    });
  });
});
