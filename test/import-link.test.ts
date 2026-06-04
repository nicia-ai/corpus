import { describe, expect, it } from "vitest";

import { asFolderSlug } from "../src/ids";
import { chooseImportLinkTarget } from "../src/store/domain/import-link";

const fs = asFolderSlug;
const created = (...slugs: readonly string[]) => new Set(slugs.map(fs));

describe("chooseImportLinkTarget", () => {
  it("no imported documents → documents", () => {
    expect(chooseImportLinkTarget([], created())).toEqual({
      kind: "documents",
    });
  });

  it("root-level documents (empty chains) → documents", () => {
    expect(chooseImportLinkTarget([[], []], created("anything"))).toEqual({
      kind: "documents",
    });
  });

  it("a fresh folder shared by every document → that folder", () => {
    expect(
      chooseImportLinkTarget([[fs("guide")], [fs("guide")]], created("guide")),
    ).toEqual({ kind: "folder", folderSlug: fs("guide") });
  });

  it("picks the topmost CREATED folder in the common prefix, skipping a pre-existing parent", () => {
    const chain = [fs("docs"), fs("proj")];
    expect(chooseImportLinkTarget([chain, chain], created("proj"))).toEqual({
      kind: "folder",
      folderSlug: fs("proj"),
    });
  });

  it("a common folder that pre-existed (not created) → documents", () => {
    expect(
      chooseImportLinkTarget([[fs("docs")], [fs("docs")]], created()),
    ).toEqual({ kind: "documents" });
  });

  it("documents under different top folders → documents (no shared wrapper)", () => {
    expect(
      chooseImportLinkTarget([[fs("a")], [fs("b")]], created("a", "b")),
    ).toEqual({ kind: "documents" });
  });

  it("links the topmost created folder of the shared prefix when chains then diverge", () => {
    expect(
      chooseImportLinkTarget(
        [
          [fs("a"), fs("b")],
          [fs("a"), fs("c")],
        ],
        created("a", "b", "c"),
      ),
    ).toEqual({ kind: "folder", folderSlug: fs("a") });
  });
});
