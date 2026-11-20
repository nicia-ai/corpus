import { InternalError } from "../../../errors";

// Git's object model, pure: hashing, tree encoding, commit encoding. Only
// what the mirror writes — blobs, trees, commits — and nothing that reads
// a repository. Uses WebCrypto (SHA-1), which every Workers runtime has.

// Byte buffers handed to WebCrypto, Blob and fetch must not be shared memory.
export type Bytes = Uint8Array<ArrayBuffer>;

export type GitObjectType = "blob" | "tree" | "commit";

export type GitObject = Readonly<{
  type: GitObjectType;
  sha: string;
  data: Bytes;
}>;

export type TreeEntry = Readonly<{ mode: string; name: string; sha: string }>;

export type Signature = Readonly<{
  name: string;
  email: string;
  // Unix seconds.
  when: number;
}>;

export type CommitInput = Readonly<{
  tree: string;
  parents: readonly string[];
  author: Signature;
  committer: Signature;
  message: string;
}>;

export const FILE_MODE = "100644";
export const DIRECTORY_MODE = "40000";

const SHA1_HEX_LENGTH = 40;
const SHA1_BYTE_LENGTH = 20;
const HEX_RADIX = 16;
const BYTE_HEX_WIDTH = 2;
const SIGNATURE_TIMEZONE = "+0000";
const FORBIDDEN_IDENTITY_CHARACTERS = /[<>\n\0]/gu;

const encoder = new TextEncoder();

export function concatBytes(parts: readonly Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(HEX_RADIX).padStart(BYTE_HEX_WIDTH, "0"),
  ).join("");
}

function fromHex(hex: string): Bytes {
  if (hex.length !== SHA1_HEX_LENGTH || !/^[0-9a-f]+$/u.test(hex)) {
    throw new InternalError(`not a SHA-1 object id: ${hex}`);
  }
  const out = new Uint8Array(SHA1_BYTE_LENGTH);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), HEX_RADIX);
  }
  return out;
}

export async function sha1(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", data));
}

// An object's id is the SHA-1 of `<type> <size>\0<payload>`.
export async function hashObject(
  type: GitObjectType,
  data: Bytes,
): Promise<GitObject> {
  const header = encoder.encode(`${type} ${String(data.length)}\0`);
  return { type, data, sha: toHex(await sha1(concatBytes([header, data]))) };
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

// Git orders a tree's entries bytewise by name, comparing a directory as if
// its name ended in "/". So the file `a.b` sorts BEFORE the directory `a`
// (`a.b` < `a/`), while the file `a` sorts before `a.b`. Getting this wrong
// still produces a valid-looking tree, but one whose hash differs from
// everyone else's and that `git fsck` rejects.
function sortKey(entry: TreeEntry): Uint8Array {
  return encoder.encode(
    entry.mode === DIRECTORY_MODE ? `${entry.name}/` : entry.name,
  );
}

export function sortTreeEntries(
  entries: readonly TreeEntry[],
): readonly TreeEntry[] {
  return entries
    .map((entry) => ({ entry, key: sortKey(entry) }))
    .sort((a, b) => compareBytes(a.key, b.key))
    .map(({ entry }) => entry);
}

export function encodeTree(entries: readonly TreeEntry[]): Bytes {
  return concatBytes(
    sortTreeEntries(entries).flatMap((entry) => {
      if (entry.name === "" || entry.name.includes("/")) {
        throw new InternalError(`invalid tree entry name: "${entry.name}"`);
      }
      return [
        encoder.encode(`${entry.mode} ${entry.name}\0`),
        fromHex(entry.sha),
      ];
    }),
  );
}

// Identity fields cannot carry the characters that delimit a signature line.
export function signatureLine(signature: Signature): string {
  const name = signature.name.replace(FORBIDDEN_IDENTITY_CHARACTERS, "").trim();
  const email = signature.email.replace(FORBIDDEN_IDENTITY_CHARACTERS, "");
  return `${name} <${email}> ${String(signature.when)} ${SIGNATURE_TIMEZONE}`;
}

export function encodeCommit(input: CommitInput): Bytes {
  const message = input.message.endsWith("\n")
    ? input.message
    : `${input.message}\n`;
  const lines = [
    `tree ${input.tree}`,
    ...input.parents.map((parent) => `parent ${parent}`),
    `author ${signatureLine(input.author)}`,
    `committer ${signatureLine(input.committer)}`,
    "",
    message,
  ];
  return encoder.encode(lines.join("\n"));
}

export const blobObject = (content: Bytes): Promise<GitObject> =>
  hashObject("blob", content);

export const treeObject = (entries: readonly TreeEntry[]): Promise<GitObject> =>
  hashObject("tree", encodeTree(entries));

export const commitObject = (input: CommitInput): Promise<GitObject> =>
  hashObject("commit", encodeCommit(input));
