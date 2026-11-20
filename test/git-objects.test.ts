import { describe, expect, it } from "vitest";

import {
  blobObject,
  commitObject,
  concatBytes,
  DIRECTORY_MODE,
  encodeTree,
  FILE_MODE,
  type GitObject,
  hashObject,
  sortTreeEntries,
  toHex,
  type TreeEntry,
  treeObject,
} from "../src/store/domain/git/objects";
import { buildPack, packObjectHeader } from "../src/store/domain/git/pack";
import {
  buildTree,
  editTree,
  type FileWrite,
  type TreeReader,
} from "../src/store/domain/git/tree-edit";
import {
  parsePktLines,
  parseReportStatus,
  pktLine,
  receivePackRequest,
  ZERO_SHA,
} from "../src/store/domain/git/wire";

// The expected ids below were produced by real `git` (hash-object, write-tree,
// commit) over the same bytes. A
// mismatch means a repository we write would not be the repository git sees.

const text = (value: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(value);
const file = (path: string, content: string): FileWrite => ({
  path,
  content: text(content),
});

const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const HELLO_BLOB = "ce013625030ba8dba906f756967f9e9ca394464a";

describe("object hashing", () => {
  it("hashes blobs like git hash-object", async () => {
    expect((await blobObject(text(""))).sha).toBe(EMPTY_BLOB);
    expect((await blobObject(text("hello\n"))).sha).toBe(HELLO_BLOB);
  });

  it("hashes the empty tree like git", async () => {
    expect((await treeObject([])).sha).toBe(EMPTY_TREE);
  });

  it("hashes bytes, not characters: CRLF, no trailing newline, unicode", async () => {
    expect((await blobObject(text("a"))).sha).toBe(
      "2e65efe2a145dda7ee51d1741299f848e5bf752e",
    );
    expect((await blobObject(text("b\r\n"))).sha).toBe(
      "485540d7ad7473f697234cebe0b55016c5dc1b40",
    );
    expect((await blobObject(text("café\n"))).sha).toBe(
      "572eb43fe8e34fb87d01c69e01151ff696022924",
    );
  });

  it("rejects an id that is not a SHA-1", () => {
    expect(() =>
      encodeTree([{ mode: FILE_MODE, name: "a", sha: "xyz" }]),
    ).toThrow(/SHA-1/u);
  });

  it("rejects a tree entry name that could escape its directory", () => {
    expect(() =>
      encodeTree([{ mode: FILE_MODE, name: "a/b", sha: EMPTY_BLOB }]),
    ).toThrow(/invalid tree entry name/u);
  });
});

describe("tree entry order", () => {
  const entry = (name: string, directory = false): TreeEntry => ({
    mode: directory ? DIRECTORY_MODE : FILE_MODE,
    name,
    sha: EMPTY_BLOB,
  });

  it("sorts a directory as if its name ended in a slash", () => {
    // `foo.txt` < `foo/` < `foo0`: '.' (0x2e) and '-' (0x2d) sort before
    // '/' (0x2f), '0' (0x30) after. Sorting by bare name would put the
    // directory first and produce a tree real git calls corrupt.
    const sorted = sortTreeEntries([
      entry("foo0"),
      entry("foo", true),
      entry("foo.txt"),
      entry("foo-x"),
      entry("docs", true),
      entry("hello.txt"),
    ]).map((e) => e.name);
    expect(sorted).toEqual([
      "docs",
      "foo-x",
      "foo.txt",
      "foo",
      "foo0",
      "hello.txt",
    ]);
  });

  it("is independent of input order", () => {
    const a = [entry("b"), entry("a", true), entry("a.b")];
    expect(encodeTree(a)).toEqual(encodeTree([...a].reverse()));
  });

  it("orders names by UTF-8 bytes, not UTF-16 units", () => {
    // U+FF5E (3 bytes, 0xef…) sorts before U+1F600 (4 bytes, 0xf0…) in UTF-8,
    // but after it in UTF-16 code units.
    const sorted = sortTreeEntries([entry("\u{1F600}"), entry("～")]);
    expect(sorted.map((e) => e.name)).toEqual(["～", "\u{1F600}"]);
  });
});

describe("a whole tree", () => {
  const corpus: readonly FileWrite[] = [
    file("hello.txt", "hello\n"),
    file("foo.txt", "a"),
    file("foo-x", "b\r\n"),
    file("foo0", "c"),
    file("foo/a.md", "# A\n"),
    file("docs/guide.md", "x\n"),
    file("docs/café.md", "café\n"),
  ];

  it("has the root tree id real git computed for the same files", async () => {
    const { root } = await buildTree(corpus);
    expect(root).toBe("1ce8d410a9e186c5ce314bc9e797c01a42ed1bb5");
  });

  it("emits every blob and tree exactly once", async () => {
    const { objects } = await buildTree([
      ...corpus,
      file("copy-of-hello.txt", "hello\n"),
    ]);
    const shas = objects.map((o) => o.sha);
    expect(new Set(shas).size).toBe(shas.length);
    // 7 distinct blobs, 3 trees (root, docs, foo); the duplicate content
    // is one blob.
    expect(objects.filter((o) => o.type === "blob")).toHaveLength(7);
    expect(objects.filter((o) => o.type === "tree")).toHaveLength(3);
  });

  it("builds the commit id real git computed", async () => {
    const commit = await commitObject({
      tree: "1ce8d410a9e186c5ce314bc9e797c01a42ed1bb5",
      parents: [],
      author: {
        name: "Ada L",
        email: "ada@users.noreply.corpus.invalid",
        when: 1_700_000_000,
      },
      committer: {
        name: "Corpus",
        email: "noreply@corpus.invalid",
        when: 1_700_000_100,
      },
      message: "Mirror corpus from Corpus\n",
    });
    expect(commit.sha).toBe("1f57f7612fe644524b24a96647999adb965c731e");
  });

  it("strips characters that would break a signature line", async () => {
    const commit = await commitObject({
      tree: EMPTY_TREE,
      parents: [],
      author: { name: "Eve <evil>\n", email: "e@x", when: 1 },
      committer: { name: "Corpus", email: "c@x", when: 1 },
      message: "m",
    });
    const body = new TextDecoder().decode(commit.data);
    expect(body).toContain("author Eve evil <e@x> 1 +0000\n");
  });
});

// A tree store standing in for the repository, keyed by sha.
function storeOf(objects: readonly GitObject[]): TreeReader {
  const trees = new Map(
    objects
      .filter((o) => o.type === "tree")
      .map((o) => [o.sha, decodeTree(o.data)] as const),
  );
  return (sha) => Promise.resolve(trees.get(sha));
}

function decodeTree(data: Uint8Array): readonly TreeEntry[] {
  const out: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0, space);
    out.push({
      mode: new TextDecoder().decode(data.subarray(at, space)),
      name: new TextDecoder().decode(data.subarray(space + 1, nul)),
      sha: toHex(data.subarray(nul + 1, nul + 21)),
    });
    at = nul + 21;
  }
  return out;
}

describe("editing a tree", () => {
  const initial = [
    file("README.md", "r\n"),
    file("docs/a.md", "a\n"),
    file("docs/deep/b.md", "b\n"),
    file("other/c.md", "c\n"),
  ];

  async function base(): Promise<
    Readonly<{ root: string; read: TreeReader; all: GitObject[] }>
  > {
    const built = await buildTree(initial);
    return {
      root: built.root ?? "",
      read: storeOf(built.objects),
      all: [...built.objects],
    };
  }

  it("writes only the objects on the changed path", async () => {
    const { root, read } = await base();
    const edited = await editTree(read, root, {
      writes: [file("docs/deep/b.md", "b2\n")],
      removals: [],
    });
    // new blob + deep + docs + root; `other` and README are untouched.
    expect(edited.objects.map((o) => o.type).sort()).toEqual([
      "blob",
      "tree",
      "tree",
      "tree",
    ]);
  });

  it("produces the same root as building the final state from scratch", async () => {
    const { root, read } = await base();
    const edited = await editTree(read, root, {
      writes: [file("docs/deep/b.md", "b2\n"), file("new/n.md", "n\n")],
      removals: ["other/c.md"],
    });
    const scratch = await buildTree([
      file("README.md", "r\n"),
      file("docs/a.md", "a\n"),
      file("docs/deep/b.md", "b2\n"),
      file("new/n.md", "n\n"),
    ]);
    expect(edited.root).toBe(scratch.root);
  });

  it("prunes a directory a removal leaves empty", async () => {
    const { root, read } = await base();
    const edited = await editTree(read, root, {
      writes: [],
      removals: ["docs/deep/b.md"],
    });
    const scratch = await buildTree([
      file("README.md", "r\n"),
      file("docs/a.md", "a\n"),
      file("other/c.md", "c\n"),
    ]);
    expect(edited.root).toBe(scratch.root);
  });

  it("is a move when one path goes and another arrives", async () => {
    const { root, read } = await base();
    const edited = await editTree(read, root, {
      writes: [file("archive/a.md", "a\n")],
      removals: ["docs/a.md"],
    });
    const scratch = await buildTree([
      file("README.md", "r\n"),
      file("archive/a.md", "a\n"),
      file("docs/deep/b.md", "b\n"),
      file("other/c.md", "c\n"),
    ]);
    expect(edited.root).toBe(scratch.root);
  });

  it("lets a file replace a directory of the same name, and back", async () => {
    const { root, read } = await base();
    const asFile = await editTree(read, root, {
      writes: [file("other", "now a file\n")],
      removals: ["other/c.md"],
    });
    expect(asFile.root).toBe(
      (
        await buildTree([
          file("README.md", "r\n"),
          file("docs/a.md", "a\n"),
          file("docs/deep/b.md", "b\n"),
          file("other", "now a file\n"),
        ])
      ).root,
    );
    const asDirectory = await editTree(read, root, {
      writes: [file("README.md/inside.md", "i\n")],
      removals: ["README.md"],
    });
    expect(asDirectory.root).toBe(
      (
        await buildTree([
          file("README.md/inside.md", "i\n"),
          file("docs/a.md", "a\n"),
          file("docs/deep/b.md", "b\n"),
          file("other/c.md", "c\n"),
        ])
      ).root,
    );
  });

  it("changes nothing when the same bytes are written again", async () => {
    const { root, read } = await base();
    const edited = await editTree(read, root, {
      writes: [file("docs/a.md", "a\n")],
      removals: [],
    });
    expect(edited.root).toBe(root);
    expect(edited.objects.filter((o) => o.type === "tree")).toHaveLength(0);
  });

  it("reports a tree the repository does not have", async () => {
    const { root } = await base();
    await expect(
      editTree(() => Promise.resolve(undefined), root, {
        writes: [file("README.md", "x")],
        removals: [],
      }),
    ).rejects.toThrow(/missing from the repository/u);
  });

  it("returns no root when everything is removed", async () => {
    const { root, read } = await base();
    const edited = await editTree(read, root, {
      writes: [],
      removals: initial.map((f) => f.path),
    });
    expect(edited.root).toBeUndefined();
  });
});

async function inflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("pack format", () => {
  it("encodes object headers: 4 size bits, then 7 per byte", () => {
    // blob = type 3. size 15 fits the first byte; 16 spills one bit over.
    expect([...packObjectHeader("blob", 0)]).toEqual([0x30]);
    expect([...packObjectHeader("blob", 15)]).toEqual([0x3f]);
    expect([...packObjectHeader("blob", 16)]).toEqual([0xb0, 0x01]);
    expect([...packObjectHeader("commit", 4096)]).toEqual([0x90, 0x80, 0x02]);
    // Larger than 2^32: a shift-based encoder would wrap.
    expect(packObjectHeader("blob", 2 ** 33).length).toBe(6);
  });

  it("frames objects between a header and a SHA-1 trailer", async () => {
    const objects = [
      await blobObject(text("hello\n")),
      await treeObject([{ mode: FILE_MODE, name: "h", sha: HELLO_BLOB }]),
    ];
    const pack = await buildPack(objects);
    expect(new TextDecoder().decode(pack.subarray(0, 4))).toBe("PACK");
    const view = new DataView(pack.buffer, pack.byteOffset);
    expect(view.getUint32(4)).toBe(2);
    expect(view.getUint32(8)).toBe(objects.length);
    const body = pack.slice(0, pack.length - 20);
    const trailer = pack.slice(pack.length - 20);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", body));
    expect(toHex(trailer)).toBe(toHex(digest));
  });

  it("deflates each payload so it inflates back to the object", async () => {
    const blob = await blobObject(text("x".repeat(5000)));
    const pack = await buildPack([blob]);
    // header(12) + object header (size 5000 = 2 bytes: 0xb8 0x4e) + zlib data
    const header = packObjectHeader("blob", 5000);
    const payload = pack.slice(12 + header.length, pack.length - 20);
    expect(new TextDecoder().decode(await inflate(payload))).toBe(
      "x".repeat(5000),
    );
  });

  it("packs an empty object list", async () => {
    const pack = await buildPack([]);
    expect(pack.length).toBe(12 + 20);
  });

  it("hashes a type/size header the way git does", async () => {
    const object = await hashObject("blob", text("hello\n"));
    expect(object.sha).toBe(HELLO_BLOB);
  });
});

describe("receive-pack wire format", () => {
  it("frames the ref update, a flush, then the pack", () => {
    const pack = new Uint8Array([1, 2, 3]);
    const body = receivePackRequest(
      { ref: "refs/heads/main", oldSha: ZERO_SHA, newSha: "a".repeat(40) },
      pack,
    );
    const textual = new TextDecoder().decode(body.subarray(0, body.length - 3));
    const command = `${ZERO_SHA} ${"a".repeat(40)} refs/heads/main\0 report-status agent=corpus-mirror\n`;
    const length = (command.length + 4).toString(16).padStart(4, "0");
    expect(textual).toBe(`${length}${command}0000`);
    expect([...body.subarray(body.length - 3)]).toEqual([1, 2, 3]);
  });

  it("round-trips pkt-lines and flushes", () => {
    const stream = concatBytes([
      pktLine("one\n"),
      pktLine("two"),
      text("0000"),
    ]);
    expect(parsePktLines(stream)).toEqual(["one\n", "two", null]);
  });

  it("refuses a malformed or truncated stream", () => {
    expect(() => parsePktLines(text("zzzzabc"))).toThrow(/malformed/u);
    expect(() => parsePktLines(text("0001"))).toThrow(/malformed/u);
    expect(() => parsePktLines(text("00ffshort"))).toThrow(/truncated/u);
  });

  const report = (...lines: string[]): Uint8Array<ArrayBuffer> =>
    concatBytes([...lines.map((l) => pktLine(`${l}\n`)), text("0000")]);

  it("reads an accepted push", () => {
    const status = parseReportStatus(report("unpack ok", "ok refs/heads/main"));
    expect(status.unpack).toBe("ok");
    expect(status.refs.get("refs/heads/main")).toEqual({ ok: true });
  });

  it("reads a refusal that arrived in an HTTP 200", () => {
    const status = parseReportStatus(
      report("unpack ok", "ng refs/heads/main stale ref"),
    );
    expect(status.refs.get("refs/heads/main")).toEqual({
      ok: false,
      reason: "stale ref",
    });
  });

  it("reads an unpack failure and a refusal with no reason", () => {
    const status = parseReportStatus(
      report("unpack index-pack abnormal exit", "ng refs/heads/main"),
    );
    expect(status.unpack).toBe("index-pack abnormal exit");
    expect(status.refs.get("refs/heads/main")).toEqual({
      ok: false,
      reason: "",
    });
  });

  it("refuses a reply that carries no report-status at all", () => {
    expect(() => parseReportStatus(text("0000"))).toThrow(/no report-status/u);
  });
});
