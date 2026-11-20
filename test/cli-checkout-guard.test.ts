import { describe, expect, it } from "vitest";

import {
  type CheckoutFs,
  containedReadText,
  regularFilesOnly,
} from "../cli/checkout-guard";
import { CliError } from "../cli/errors";

const ROOT = "/work/checkout";
const OUTSIDE_SECRET = "/home/me/.ssh/notes.md";

// A disk where `link.md` and `linked/doc.md` resolve outside the checkout,
// `inner-link.md` resolves inside it, and `dangling.md` points at nothing.
const REAL: Readonly<Record<string, string | undefined>> = {
  [ROOT]: ROOT,
  [`${ROOT}/plain.md`]: `${ROOT}/plain.md`,
  [`${ROOT}/link.md`]: OUTSIDE_SECRET,
  [`${ROOT}/linked/doc.md`]: "/elsewhere/doc.md",
  [`${ROOT}/inner-link.md`]: `${ROOT}/plain.md`,
  [`${ROOT}/sibling-prefix.md`]: "/work/checkout-evil/a.md",
};
const REGULAR = new Set([`${ROOT}/plain.md`]);

const fs: CheckoutFs = {
  realPath: (path) => Promise.resolve(REAL[path]),
  isRegularFile: (path) => Promise.resolve(REGULAR.has(path)),
};

describe("containedReadText", () => {
  const reads: string[] = [];
  const read = containedReadText(ROOT, fs, (path) => {
    reads.push(path);
    return Promise.resolve(`text of ${path}`);
  });

  it("reads a file that resolves inside the checkout", async () => {
    await expect(read(`${ROOT}/plain.md`)).resolves.toBe(
      `text of ${ROOT}/plain.md`,
    );
    await expect(read(`${ROOT}/inner-link.md`)).resolves.toBeDefined();
  });

  it.each([
    ["a link to a file elsewhere", `${ROOT}/link.md`],
    ["a path under a linked folder", `${ROOT}/linked/doc.md`],
    ["a sibling folder sharing the root's prefix", `${ROOT}/sibling-prefix.md`],
  ])("refuses %s without reading it", async (_label, path) => {
    reads.length = 0;
    await expect(read(path)).rejects.toSatisfy(
      (error) => error instanceof CliError && error.kind === "unsafe-path",
    );
    expect(reads).toEqual([]);
  });

  it("reads an absent or dangling path as missing", async () => {
    await expect(read(`${ROOT}/dangling.md`)).resolves.toBeUndefined();
  });
});

describe("regularFilesOnly", () => {
  it("drops links and anything that is not a regular file", async () => {
    const kept = await regularFilesOnly(
      ROOT,
      ["plain.md", "link.md", "inner-link.md", "linked"],
      fs,
      (dir, path) => `${dir}/${path}`,
    );
    expect(kept).toEqual(["plain.md"]);
  });
});
