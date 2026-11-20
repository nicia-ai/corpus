import {
  type Bytes,
  concatBytes,
  type GitObject,
  type GitObjectType,
  sha1,
} from "./objects";

// Git packfile (version 2) with whole, undeltified objects — the simplest
// pack a receiver accepts. Layout: "PACK", version, object count, then per
// object a variable-length type+size header and its zlib-deflated payload,
// closed by the SHA-1 of everything before it.

export const PACK_VERSION = 2;

const PACK_SIGNATURE = "PACK";
const PACK_HEADER_BYTES = 12;
const PACK_VERSION_OFFSET = 4;
const PACK_COUNT_OFFSET = 8;

const TYPE_CODES: Readonly<Record<GitObjectType, number>> = {
  commit: 1,
  tree: 2,
  blob: 3,
};

const SIZE_LOW_BITS = 4;
const SIZE_LOW_MASK = 0x0f;
const SIZE_CONTINUATION_BITS = 7;
const SIZE_CONTINUATION_MASK = 0x7f;
const CONTINUATION_FLAG = 0x80;
const TYPE_SHIFT = 4;

// Header bytes: the first holds the type and the low 4 bits of the size;
// each further byte holds 7 more size bits, least significant first, with
// the top bit set while more follow. Sizes are divided, not shifted: a
// file can exceed what a 32-bit shift keeps.
export function packObjectHeader(type: GitObjectType, size: number): Bytes {
  const out: number[] = [];
  let byte = (TYPE_CODES[type] << TYPE_SHIFT) | (size & SIZE_LOW_MASK);
  let rest = Math.floor(size / 2 ** SIZE_LOW_BITS);
  while (rest > 0) {
    out.push(byte | CONTINUATION_FLAG);
    byte = rest & SIZE_CONTINUATION_MASK;
    rest = Math.floor(rest / 2 ** SIZE_CONTINUATION_BITS);
  }
  out.push(byte);
  return Uint8Array.from(out);
}

async function deflate(data: Bytes): Promise<Bytes> {
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function buildPack(objects: readonly GitObject[]): Promise<Bytes> {
  const header = new Uint8Array(PACK_HEADER_BYTES);
  header.set(new TextEncoder().encode(PACK_SIGNATURE));
  const view = new DataView(header.buffer);
  view.setUint32(PACK_VERSION_OFFSET, PACK_VERSION);
  view.setUint32(PACK_COUNT_OFFSET, objects.length);
  const parts: Uint8Array[] = [header];
  for (const object of objects) {
    parts.push(
      packObjectHeader(object.type, object.data.length),
      await deflate(object.data),
    );
  }
  const body = concatBytes(parts);
  return concatBytes([body, await sha1(body)]);
}
