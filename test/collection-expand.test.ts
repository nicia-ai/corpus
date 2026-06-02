import { describe, expect, it } from "vitest";

import {
  expandCollection,
  expandCollectionDocuments,
  type ExpandEntry,
  type FolderTree,
} from "../src/store/domain/collection-expand";

const tree: FolderTree = new Map([
  [
    "guide",
    {
      slug: "guide",
      childFolders: [
        { slug: "guide-api", position: 2 },
        { slug: "guide-intro", position: 1 },
      ],
      documents: [
        { slug: "guide-zeta", filename: "zeta.md" },
        { slug: "guide-alpha", filename: "alpha.md" },
      ],
    },
  ],
  [
    "guide-intro",
    {
      slug: "guide-intro",
      childFolders: [],
      documents: [{ slug: "intro-readme", filename: "readme.md" }],
    },
  ],
  [
    "guide-api",
    {
      slug: "guide-api",
      childFolders: [],
      documents: [{ slug: "api-auth", filename: "auth.md" }],
    },
  ],
]);

describe("expandCollection (the single folder→collection resolver)", () => {
  it("merges direct + folder entries by the shared position space", () => {
    const entries: ExpandEntry[] = [
      { type: "document", slug: "top", position: 1 },
      { type: "folder", slug: "guide", position: 2 },
      { type: "document", slug: "bottom", position: 3 },
    ];
    expect(expandCollection(entries, tree)).toEqual([
      "top",
      // folder: own docs by filename, then child folders by position
      "guide-alpha",
      "guide-zeta",
      "intro-readme", // guide-intro (position 1)
      "api-auth", // guide-api (position 2)
      "bottom",
    ]);
  });

  it("depth-first pre-order: a folder's own docs precede its subfolders", () => {
    const entries: ExpandEntry[] = [
      { type: "folder", slug: "guide", position: 1 },
    ];
    expect(expandCollection(entries, tree)).toEqual([
      "guide-alpha",
      "guide-zeta",
      "intro-readme",
      "api-auth",
    ]);
  });

  it("dedupes by first occurrence (direct include before a folder wins)", () => {
    const entries: ExpandEntry[] = [
      { type: "document", slug: "api-auth", position: 1 },
      { type: "folder", slug: "guide", position: 2 },
    ];
    const out = expandCollection(entries, tree);
    expect(out.filter((s) => s === "api-auth")).toEqual(["api-auth"]);
    expect(out[0]).toBe("api-auth");
  });

  it("a missing folder contributes nothing", () => {
    const entries: ExpandEntry[] = [
      { type: "folder", slug: "ghost", position: 1 },
      { type: "document", slug: "only", position: 2 },
    ];
    expect(expandCollection(entries, tree)).toEqual(["only"]);
  });

  it("is deterministic and order-insensitive in the input array", () => {
    const a: ExpandEntry[] = [
      { type: "folder", slug: "guide", position: 2 },
      { type: "document", slug: "top", position: 1 },
    ];
    const b: ExpandEntry[] = [
      { type: "document", slug: "top", position: 1 },
      { type: "folder", slug: "guide", position: 2 },
    ];
    expect(expandCollection(a, tree)).toEqual(expandCollection(b, tree));
  });

  it("is cycle-guarded (a corrupted self-parent folder terminates)", () => {
    const cyclic: FolderTree = new Map([
      [
        "loop",
        {
          slug: "loop",
          childFolders: [{ slug: "loop", position: 1 }],
          documents: [{ slug: "d", filename: "d.md" }],
        },
      ],
    ]);
    expect(
      expandCollection([{ type: "folder", slug: "loop", position: 1 }], cyclic),
    ).toEqual(["d"]);
  });

  it("no folders → exactly the direct documents in position order", () => {
    const entries: ExpandEntry[] = [
      { type: "document", slug: "b", position: 2 },
      { type: "document", slug: "a", position: 1 },
    ];
    expect(expandCollection(entries, new Map())).toEqual(["a", "b"]);
  });

  it("a direct membership's delivery is authoritative over a folder's", () => {
    // api-auth is reachable via the `guide` subtree (folder, core) AND
    // included directly as reference. The explicit direct choice wins —
    // it is NOT promoted to core by the folder.
    const directReference: ExpandEntry[] = [
      { type: "folder", slug: "guide", position: 1, delivery: "core" },
      {
        type: "document",
        slug: "api-auth",
        position: 2,
        delivery: "reference",
      },
    ];
    expect(
      expandCollectionDocuments(directReference, tree).find(
        (d) => d.slug === "api-auth",
      ),
    ).toEqual({ slug: "api-auth", delivery: "reference" });

    // Symmetric: a direct core member is core even inside a reference
    // folder (and regardless of which is positioned first).
    const directCore: ExpandEntry[] = [
      { type: "document", slug: "api-auth", position: 1, delivery: "core" },
      { type: "folder", slug: "guide", position: 2, delivery: "reference" },
    ];
    expect(
      expandCollectionDocuments(directCore, tree).find(
        (d) => d.slug === "api-auth",
      ),
    ).toEqual({ slug: "api-auth", delivery: "core" });
  });

  it("among folder-only memberships, core (most inclusive) wins", () => {
    // guide-api is reachable only via folders here; the core link wins
    // over the reference link.
    const entries: ExpandEntry[] = [
      {
        type: "folder",
        slug: "guide-api",
        position: 1,
        delivery: "reference",
      },
      { type: "folder", slug: "guide", position: 2, delivery: "core" },
    ];
    expect(
      expandCollectionDocuments(entries, tree).find(
        (d) => d.slug === "api-auth",
      ),
    ).toEqual({ slug: "api-auth", delivery: "core" });
  });
});
