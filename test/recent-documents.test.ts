import { describe, expect, it } from "vitest";

import { docSlug, freshStore } from "./_helpers";

// Document timestamps have millisecond precision; keep saves ordered.
const waitForNextTimestamp = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 3));

describe("recent documents", () => {
  it("takes the newest five live heads after sorting the full set", async () => {
    const store = freshStore("recent-documents");
    for (const slug of ["a", "b", "c", "d", "e", "f", "g"]) {
      await store.saveDocument({
        slug: docSlug(slug),
        markdown: `# ${slug}`,
        clientVersion: 0,
        changedBy: "author",
      });
      await waitForNextTimestamp();
    }

    await store.archiveDocument(docSlug("g"), "author");
    await waitForNextTimestamp();
    await store.saveDocument({
      slug: docSlug("a"),
      markdown: "# a\n\nUpdated",
      clientVersion: 1,
      changedBy: "author",
    });

    expect((await store.recentDocuments()).map((doc) => doc.slug)).toEqual([
      "a",
      "f",
      "e",
      "d",
      "c",
    ]);
  });
});
