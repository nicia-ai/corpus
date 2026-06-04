import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  collectFromFiles,
  commonRoot,
  placeEntries,
} from "../src/lib/upload/collect";

function zipFile(entries: Record<string, string>, name = "docs.zip"): File {
  const bytes = zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([k, v]) => [k, strToU8(v)]),
    ),
  );
  return new File([bytes], name);
}

describe("collectFromFiles — loose files", () => {
  it("keeps text files, partitions unsupported ones with a reason", async () => {
    const r = await collectFromFiles([
      new File(["# A"], "a.md"),
      new File(["plain"], "notes.txt"),
      new File(["..."], "logo.png"),
    ]);
    expect(r.files.map((f) => f.path).sort()).toEqual(["a.md", "notes.txt"]);
    expect(r.skipped).toEqual([
      { path: "logo.png", reason: "unsupported file type" },
    ]);
  });
});

describe("collectFromFiles — zip", () => {
  it("expands a zip, preserves folder structure, drops cruft", async () => {
    const file = zipFile({
      "guide/intro.md": "# Intro",
      "guide/api/auth.md": "# Auth",
      "guide/diagram.png": "binary",
      "__MACOSX/guide/._intro.md": "junk",
      ".DS_Store": "junk",
    });
    const r = await collectFromFiles([file]);
    expect(r.files.map((f) => f.path).sort()).toEqual([
      "guide/api/auth.md",
      "guide/intro.md",
    ]);
    expect(r.files.find((f) => f.path === "guide/intro.md")?.text).toBe(
      "# Intro",
    );
    expect(r.skipped).toContainEqual({
      path: "docs › guide/diagram.png",
      reason: "unsupported file type",
    });
  });

  it("detects a zip by magic bytes even without a .zip name", async () => {
    const file = zipFile({ "x.md": "# X" }, "archive");
    const r = await collectFromFiles([file]);
    expect(r.files.map((f) => f.path)).toEqual(["x.md"]);
  });
});

describe("commonRoot / placeEntries", () => {
  it("commonRoot is the single shared top dir, else null", () => {
    expect(
      commonRoot([
        { path: "docs/a.md", text: "" },
        { path: "docs/sub/b.md", text: "" },
      ]),
    ).toBe("docs");
    expect(
      commonRoot([
        { path: "docs/a.md", text: "" },
        { path: "other/b.md", text: "" },
      ]),
    ).toBeNull();
    expect(commonRoot([{ path: "loose.md", text: "" }])).toBeNull();
  });

  it("a single loose file lands at the root, no folder synthesized", () => {
    expect(
      placeEntries([{ path: "loose.md", text: "x" }], [], false).map(
        (f) => f.path,
      ),
    ).toEqual(["loose.md"]);
  });

  it("places a file into an existing folder", () => {
    expect(
      placeEntries([{ path: "loose.md", text: "x" }], ["docs"], false).map(
        (f) => f.path,
      ),
    ).toEqual(["docs/loose.md"]);
  });

  it("keeps an uploaded folder as-is under the destination", () => {
    const files = [
      { path: "my-docs/a.md", text: "x" },
      { path: "my-docs/specs/b.md", text: "y" },
    ];
    expect(placeEntries(files, [], false).map((f) => f.path)).toEqual([
      "my-docs/a.md",
      "my-docs/specs/b.md",
    ]);
    expect(placeEntries(files, ["team"], false).map((f) => f.path)).toEqual([
      "team/my-docs/a.md",
      "team/my-docs/specs/b.md",
    ]);
  });

  it("merges an uploaded folder's files into the destination, structure kept", () => {
    const files = [
      { path: "my-docs/a.md", text: "x" },
      { path: "my-docs/specs/b.md", text: "y" },
    ];
    expect(placeEntries(files, ["docs"], true).map((f) => f.path)).toEqual([
      "docs/a.md",
      "docs/specs/b.md",
    ]);
  });
});

// — Drag-drop entry walking (collectFromDataTransfer). Fakes the browser
//   DataTransferItemList + FileSystemEntry API to exercise the path the
//   real tests never hit (jsdom has no FileSystem entry API).

type FakeEntry =
  | {
      isFile: true;
      isDirectory: false;
      fullPath: string;
      file: (cb: (f: File) => void, err: (e: unknown) => void) => void;
    }
  | {
      isFile: false;
      isDirectory: true;
      fullPath: string;
      createReader: () => {
        readEntries: (
          cb: (e: readonly FakeEntry[]) => void,
          err: (e: unknown) => void,
        ) => void;
      };
    };

function fileEntry(path: string, text: string): FakeEntry {
  return {
    isFile: true,
    isDirectory: false,
    fullPath: path,
    // Mirrors the real API: a method that relies on `this` being the
    // entry. The collector must call it bound or this throws/misbehaves.
    file(cb) {
      if (this.fullPath === undefined)
        throw new TypeError("Illegal invocation");
      cb(new File([text], path.split("/").pop() ?? path));
    },
  };
}

function dirEntry(path: string, children: readonly FakeEntry[]): FakeEntry {
  return {
    isFile: false,
    isDirectory: true,
    fullPath: path,
    createReader() {
      if (this.fullPath === undefined)
        throw new TypeError("Illegal invocation");
      let drained = false;
      return {
        readEntries(cb) {
          if (drained) cb([]);
          else {
            drained = true;
            cb(children);
          }
        },
      };
    },
  };
}

function dataTransfer(
  entries: readonly FakeEntry[],
  files: readonly File[] = [],
): DataTransfer {
  const items = entries.map((entry) => ({
    kind: "file",
    webkitGetAsEntry: () => entry,
    getAsFile: () => null,
  }));
  return { items, files } as unknown as DataTransfer;
}

describe("collectFromDataTransfer — dropped folder", () => {
  it("walks a dropped directory tree into files", async () => {
    const dt = dataTransfer([
      dirEntry("/docs", [
        fileEntry("/docs/intro.md", "# Intro"),
        dirEntry("/docs/api", [fileEntry("/docs/api/auth.md", "# Auth")]),
        fileEntry("/docs/logo.png", "binary"),
      ]),
    ]);
    const { collectFromDataTransfer } =
      await import("../src/lib/upload/collect");
    const r = await collectFromDataTransfer(dt);
    expect(r.files.map((f) => f.path).sort()).toEqual([
      "docs/api/auth.md",
      "docs/intro.md",
    ]);
  });

  it("falls back to dataTransfer.files when the items API is empty", async () => {
    const dt = dataTransfer(
      [],
      [new File(["# A"], "a.md"), new File(["x"], "logo.png")],
    );
    const { collectFromDataTransfer } =
      await import("../src/lib/upload/collect");
    const r = await collectFromDataTransfer(dt);
    expect(r.files.map((f) => f.path)).toEqual(["a.md"]);
    expect(r.skipped).toContainEqual({
      path: "logo.png",
      reason: "unsupported file type",
    });
  });
});
