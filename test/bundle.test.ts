import { describe, expect, it } from "vitest";

import {
  type Bundle,
  type BundleFolder,
  BUNDLE_VERSION,
  canonicalJson,
  computeRootHash,
  foldersInDependencyOrder,
  parseBundle,
  PRODUCT_VERSION,
} from "../src/store/domain/bundle";

import { colSlug, docSlug, freshStore } from "./_helpers";

const SOURCE = { organization: "acme", project: "default" };

// Compare two bundles ignoring the only wall-clock field (exportedAt);
// everything else — including integrity.rootHash — must be identical.
function stable(b: Bundle): string {
  return canonicalJson({
    ...b,
    manifest: { ...b.manifest, exportedAt: "<normalized>" },
  });
}

describe("bundle domain (pure)", () => {
  it("rootHash is deterministic and order-independent", async () => {
    const a = await computeRootHash({
      x: [
        {
          slug: "x",
          docVersion: 1,
          contentHash: "h1",
          prevContentHash: null,
          changedAt: "t",
          changedBy: "u",
        },
        {
          slug: "x",
          docVersion: 2,
          contentHash: "h2",
          prevContentHash: "h1",
          changedAt: "t",
          changedBy: "u",
        },
      ],
    });
    const b = await computeRootHash({
      x: [
        {
          slug: "x",
          docVersion: 2,
          contentHash: "h2",
          prevContentHash: "h1",
          changedAt: "t",
          changedBy: "u",
        },
        {
          slug: "x",
          docVersion: 1,
          contentHash: "h1",
          prevContentHash: null,
          changedAt: "t",
          changedBy: "u",
        },
      ],
    });
    expect(a).toBe(b);
    expect(a.startsWith("sha256:")).toBe(true);
  });

  it("canonicalJson sorts keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it("PRODUCT_VERSION is a semver string (kept in lockstep with package.json)", () => {
    expect(PRODUCT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("foldersInDependencyOrder emits every parent before its children", () => {
    const f = (slug: string, parentSlug: string | null): BundleFolder => ({
      slug,
      name: slug,
      parentSlug,
      position: 1,
    });
    // Deliberately scrambled; grandchild before root.
    const ordered = foldersInDependencyOrder([
      f("a-b-c", "a-b"),
      f("a", null),
      f("a-b", "a"),
      f("z", null),
    ]).map((x) => x.slug);
    for (const [child, parent] of [
      ["a-b", "a"],
      ["a-b-c", "a-b"],
    ]) {
      expect(ordered.indexOf(parent)).toBeLessThan(ordered.indexOf(child));
    }
    expect([...ordered].sort()).toEqual(["a", "a-b", "a-b-c", "z"]);
  });
});

describe("bundle round-trip (the alignment contract)", () => {
  it("export → fresh project → import → export is byte-identical", async () => {
    const a = freshStore("bundle-a");
    await a.saveDocument({
      slug: docSlug("alpha"),
      markdown: "# Alpha\nv1",
      clientVersion: 0,
      changedBy: "u",
    });
    await a.saveDocument({
      slug: docSlug("alpha"),
      markdown: "# Alpha\nv2 expanded",
      clientVersion: 1,
      changedBy: "u",
    });
    await a.saveDocument({
      slug: docSlug("beta"),
      markdown: "# Beta",
      clientVersion: 0,
      changedBy: "u",
    });
    await a.createCollection({
      slug: colSlug("team"),
      name: "Team",
      description: "shared",
      changedBy: "u",
    });
    await a.attachDocument(colSlug("team"), docSlug("alpha"), 1, "u");
    await a.attachDocument(colSlug("team"), docSlug("beta"), 2, "u");

    const b1 = await a.exportBundle(SOURCE);

    const b = freshStore("bundle-b");
    const imp = await b.importBundle(b1);
    expect(imp).toEqual({ ok: true, documents: 2, collections: 1 });

    const b2 = await b.exportBundle(SOURCE);

    expect(stable(b2)).toBe(stable(b1));
    expect(b2.manifest.integrity.rootHash).toBe(b1.manifest.integrity.rootHash);

    // The imported project is functional, not just re-exportable.
    expect((await b.getDocument(docSlug("alpha")))?.markdown).toBe(
      "# Alpha\nv2 expanded",
    );
    expect(await b.verifyHistory()).toEqual({ ok: true });
    const col = await b.readCollection(colSlug("team"));
    expect(col.found).toBe(true);
    if (col.found) {
      expect(col.documents.map((d) => d.slug)).toEqual(["alpha", "beta"]);
    }
  });

  it("round-trips alwaysIncludeBudgetTokens through export → import", async () => {
    const a = freshStore("bundle-budget");
    await a.saveDocument({
      slug: docSlug("brand"),
      markdown: "# Brand",
      clientVersion: 0,
      changedBy: "u",
    });
    await a.createCollection({
      slug: colSlug("mkt"),
      name: "Marketing",
      alwaysIncludeBudgetTokens: 32_000,
      changedBy: "u",
    });
    await a.attachDocument(colSlug("mkt"), docSlug("brand"), 1, "u");

    const b1 = await a.exportBundle(SOURCE);
    expect(b1.collections["mkt"]?.alwaysIncludeBudgetTokens).toBe(32_000);
    expect(
      b1.manifest.collections.find((c) => c.slug === "mkt")
        ?.alwaysIncludeBudgetTokens,
    ).toBe(32_000);

    const b = freshStore("bundle-budget2");
    expect((await b.importBundle(b1)).ok).toBe(true);

    // The value is live in the imported project, not merely re-exportable.
    const live = await b.collectionStructure(colSlug("mkt"));
    expect(live.found && live.alwaysIncludeBudgetTokens).toBe(32_000);

    const b2 = await b.exportBundle(SOURCE);
    expect(stable(b2)).toBe(stable(b1));
  });

  it("round-trips Core/Reference membership delivery", async () => {
    const a = freshStore("bundle-delivery-a");
    await a.saveDocument({
      slug: docSlug("core-doc"),
      markdown: "# Core",
      clientVersion: 0,
      changedBy: "u",
    });
    await a.saveDocument({
      slug: docSlug("reference-doc"),
      markdown: "# Reference",
      clientVersion: 0,
      changedBy: "u",
    });
    await a.createCollection({
      slug: colSlug("agent"),
      name: "Agent",
      changedBy: "u",
    });
    await a.attachDocument(
      colSlug("agent"),
      docSlug("core-doc"),
      1,
      "u",
      "core",
    );
    await a.attachDocument(
      colSlug("agent"),
      docSlug("reference-doc"),
      2,
      "u",
      "reference",
    );

    const b1 = await a.exportBundle(SOURCE);
    expect(
      b1.collections["agent"]?.members.map((m) => [m.documentSlug, m.delivery]),
    ).toEqual([
      ["core-doc", "core"],
      ["reference-doc", "reference"],
    ]);

    const b = freshStore("bundle-delivery-b");
    expect((await b.importBundle(b1)).ok).toBe(true);
    expect(stable(await b.exportBundle(SOURCE))).toBe(stable(b1));

    const live = await b.readCollection(colSlug("agent"));
    expect(live.found).toBe(true);
    if (live.found) {
      expect(live.documents.map((d) => d.slug)).toEqual(["core-doc"]);
    }
  });

  it("round-trips folders + filename + placement byte-identically", async () => {
    const a = freshStore("bundle-f");
    await a.importDocumentAtPath({
      path: "a/b/zeta.md",
      markdown: "# Zeta",
      changedBy: "u",
    });
    await a.importDocumentAtPath({
      path: "a/b/alpha.md",
      markdown: "# Alpha",
      changedBy: "u",
    });
    await a.importDocumentAtPath({
      path: "top.md",
      markdown: "# Top",
      changedBy: "u",
    });
    const bFolder = (await a.listFolders()).find((f) => f.name === "b");
    if (bFolder === undefined) throw new Error("folder b missing");
    await a.createCollection({
      slug: colSlug("team"),
      name: "Team",
      changedBy: "u",
    });
    await a.attachFolderToCollection(colSlug("team"), bFolder.slug, 1, "u");

    const b1 = await a.exportBundle(SOURCE);

    // The delta is actually present in the manifest.
    expect(b1.manifest.folders.map((f) => f.name).sort()).toEqual(["a", "b"]);
    const zetaMeta = b1.manifest.documents.find((d) => d.slug === "a-b-zeta");
    expect(zetaMeta?.filename).toBe("zeta.md");
    expect(zetaMeta?.folderSlug).toBe(bFolder.slug);
    expect(
      b1.manifest.documents.find((d) => d.slug === "top")?.folderSlug,
    ).toBe(null);

    const b = freshStore("bundle-g");
    const imp = await b.importBundle(b1);
    expect(imp).toEqual({ ok: true, documents: 3, collections: 1 });

    const b2 = await b.exportBundle(SOURCE);
    expect(stable(b2)).toBe(stable(b1));
    expect(b2.manifest.integrity.rootHash).toBe(b1.manifest.integrity.rootHash);

    // Functional after import: chain verifies, the folder→collection
    // snapshot resolved to its pinned (expanded) members.
    expect(await b.verifyHistory()).toEqual({ ok: true });
    const col = await b.readCollection(colSlug("team"));
    expect(col.found).toBe(true);
    if (col.found) {
      expect(col.documents.map((d) => d.slug)).toEqual([
        "a-b-alpha",
        "a-b-zeta",
      ]);
    }
  });

  it("exports the LIVE resolved expansion: docs added to a linked folder after attach are in the bundle", async () => {
    const a = freshStore("bundle-h");
    await a.importDocumentAtPath({
      path: "a/first.md",
      markdown: "# First",
      changedBy: "u",
    });
    await a.createCollection({
      slug: colSlug("team"),
      name: "Team",
      changedBy: "u",
    });
    const folderA = (await a.listFolders()).find((f) => f.name === "a");
    if (folderA === undefined) throw new Error("folder a missing");
    await a.attachFolderToCollection(colSlug("team"), folderA.slug, 1, "u");

    // Added AFTER the folder→collection link, with no explicit
    // collection action — readCollection shows it, so the bundle must
    // too.
    await a.importDocumentAtPath({
      path: "a/second.md",
      markdown: "# Second",
      changedBy: "u",
    });

    const b1 = await a.exportBundle(SOURCE);
    const teamMembers = b1.manifest.collections
      .find((c) => c.slug === "team")
      ?.members.map((m) => m.documentSlug)
      .sort();
    expect(teamMembers).toEqual(["a-first", "a-second"]);

    // And it still round-trips byte-identically.
    const b = freshStore("bundle-i");
    expect((await b.importBundle(b1)).ok).toBe(true);
    const b2 = await b.exportBundle(SOURCE);
    expect(stable(b2)).toBe(stable(b1));
    const imported = await b.readCollection(colSlug("team"));
    expect(imported.found).toBe(true);
    if (imported.found) {
      expect(imported.documents.map((d) => d.slug).sort()).toEqual([
        "a-first",
        "a-second",
      ]);
    }
  });

  it("deleting a linked folder re-snapshots: the bundle no longer serves the stale expansion", async () => {
    const a = freshStore("bundle-j");
    await a.importDocumentAtPath({
      path: "a/doc.md",
      markdown: "# Doc",
      changedBy: "u",
    });
    await a.createCollection({
      slug: colSlug("team"),
      name: "Team",
      changedBy: "u",
    });
    const folderA = (await a.listFolders()).find((f) => f.name === "a");
    if (folderA === undefined) throw new Error("folder a missing");
    await a.attachFolderToCollection(colSlug("team"), folderA.slug, 1, "u");

    const before = await a.exportBundle(SOURCE);
    expect(
      before.manifest.collections.find((c) => c.slug === "team")?.members,
    ).toHaveLength(1);

    expect((await a.deleteFolder(folderA.slug, "u")).ok).toBe(true);

    // readCollection and exportBundle must agree: the link is gone.
    const live = await a.readCollection(colSlug("team"));
    expect(live.found && live.documents).toEqual([]);
    const after = await a.exportBundle(SOURCE);
    expect(
      after.manifest.collections.find((c) => c.slug === "team")?.members,
    ).toEqual([]);

    // Still a clean byte-identical round-trip.
    const b = freshStore("bundle-k");
    expect((await b.importBundle(after)).ok).toBe(true);
    expect(stable(await b.exportBundle(SOURCE))).toBe(stable(after));
  });

  it("rejects a bundle whose rootHash does not match its history", async () => {
    const a = freshStore("bundle-c");
    await a.saveDocument({
      slug: docSlug("doc"),
      markdown: "original",
      clientVersion: 0,
      changedBy: "u",
    });
    const good = await a.exportBundle(SOURCE);

    // Tamper a history line without recomputing the manifest rootHash.
    const tampered: Bundle = {
      ...good,
      history: {
        ...good.history,
        doc: (good.history.doc ?? []).map((l) => ({
          ...l,
          contentHash: "sha256:deadbeef",
        })),
      },
    };
    const b = freshStore("bundle-d");
    expect(await b.importBundle(tampered)).toEqual({
      ok: false,
      reason: "root-hash-mismatch",
    });
    // Nothing was written (atomic reject before the tx).
    expect(await b.getDocument(docSlug("doc"))).toBeUndefined();
  });
});

// parseBundle is the server-fn-side preflight: it returns a discriminated
// outcome with the got/expected version pair when a stale bundle hits a
// newer importer, instead of throwing a generic Zod literal mismatch
// the UI couldn't translate.
describe("parseBundle (import preflight)", () => {
  it("returns version-mismatch with got + expected for an older bundle", () => {
    const v2Payload = {
      manifest: {
        kind: "corpus-bundle",
        bundleVersion: "2",
        exportedAt: "2026-05-01T00:00:00.000Z",
        source: {
          product: "corpus",
          productVersion: PRODUCT_VERSION,
          organization: "acme",
          project: "default",
        },
        documents: [],
        folders: [],
        collections: [],
        integrity: { algorithm: "sha256", rootHash: "x" },
      },
      documents: {},
      collections: {},
      history: {},
      blobs: {},
    };
    expect(parseBundle(v2Payload)).toEqual({
      ok: false,
      reason: "version-mismatch",
      got: "2",
      expected: BUNDLE_VERSION,
    });
  });

  it("returns invalid-bundle-shape when manifest.bundleVersion is missing", () => {
    expect(parseBundle({ notABundle: true })).toMatchObject({
      ok: false,
      reason: "invalid-bundle-shape",
    });
  });

  it("returns invalid-bundle-shape when the version matches but the body is malformed", () => {
    const r = parseBundle({
      manifest: { bundleVersion: BUNDLE_VERSION },
      // rest of the manifest + records missing — fails the full schema
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid-bundle-shape");
  });
});
