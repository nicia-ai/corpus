import { sha256Hex } from "../src/util";

// Small byte strings the server's sniffer reads as images and attachments,
// shared by the tests that move files through the mirror, the REST surface and
// the CLI. Distinct `seed`s give distinct bytes (so distinct hashes).

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];
const encoder = new TextEncoder();

export const png = (seed = "a"): Uint8Array<ArrayBuffer> =>
  new Uint8Array([...PNG_MAGIC, ...encoder.encode(seed)]);

export const jpeg = (seed = "a"): Uint8Array<ArrayBuffer> =>
  new Uint8Array([...JPEG_MAGIC, ...encoder.encode(seed)]);

export const pdf = (seed = "a"): Uint8Array<ArrayBuffer> =>
  encoder.encode(`%PDF-1.4\n${seed}\n%%EOF`);

export const svg = (seed = "a"): Uint8Array<ArrayBuffer> =>
  encoder.encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><title>${seed}</title><rect width="10" height="10"/></svg>`,
  );

// `length` bytes that start like a PNG and are otherwise pseudo-random, so
// deflate cannot shrink them (a real photo behaves the same way). Deterministic
// in `seed`.
export function noisyPng(
  length: number,
  seed: number,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  out.set(PNG_MAGIC);
  let state = seed >>> 0 || 1;
  for (let i = PNG_MAGIC.length; i < length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out;
}

export const hashOf = (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  sha256Hex(bytes);

export const bytesOf = (text: string): Uint8Array<ArrayBuffer> =>
  encoder.encode(text);

export const textOf = (bytes: Uint8Array): string =>
  new TextDecoder().decode(bytes);
