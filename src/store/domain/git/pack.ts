import { isAlreadyCompressed } from "../file-kinds";

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
// closed by the SHA-1 of everything before it. A blob that is already a
// compressed image is stored as-is inside the zlib wrapper rather than
// deflated again.

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

// zlib stream of "stored" (uncompressed) deflate blocks: a valid payload a
// receiver inflates like any other, for bytes that deflate cannot shrink.
const ZLIB_HEADER = [0x78, 0x01];
const STORED_BLOCK_MAX = 0xffff;
const ADLER_MODULUS = 65_521;
// The most bytes summed before the running totals must be reduced, so they
// stay exact in a double.
const ADLER_BATCH = 5552;
const WORD_SHIFT = 16;

function adler32(data: Bytes): number {
  let a = 1;
  let b = 0;
  for (let start = 0; start < data.length; start += ADLER_BATCH) {
    const end = Math.min(start + ADLER_BATCH, data.length);
    for (let i = start; i < end; i += 1) {
      a += data[i] ?? 0;
      b += a;
    }
    a %= ADLER_MODULUS;
    b %= ADLER_MODULUS;
  }
  return ((b << WORD_SHIFT) | a) >>> 0;
}

export function storeDeflate(data: Bytes): Bytes {
  const blocks = Math.max(1, Math.ceil(data.length / STORED_BLOCK_MAX));
  const header = ZLIB_HEADER.length;
  const out = new Uint8Array(header + blocks * 5 + data.length + 4);
  out.set(ZLIB_HEADER);
  const view = new DataView(out.buffer);
  let at = header;
  for (let block = 0; block < blocks; block += 1) {
    const from = block * STORED_BLOCK_MAX;
    const part = data.subarray(from, from + STORED_BLOCK_MAX);
    out[at] = block === blocks - 1 ? 1 : 0;
    view.setUint16(at + 1, part.length, true);
    view.setUint16(at + 3, ~part.length & STORED_BLOCK_MAX, true);
    out.set(part, at + 5);
    at += 5 + part.length;
  }
  view.setUint32(at, adler32(data));
  return out;
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
      object.type === "blob" && isAlreadyCompressed(object.data)
        ? storeDeflate(object.data)
        : await deflate(object.data),
    );
  }
  const body = concatBytes(parts);
  return concatBytes([body, await sha1(body)]);
}
