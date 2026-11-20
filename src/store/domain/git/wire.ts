import { InternalError } from "../../../errors";

import { type Bytes, concatBytes } from "./objects";

// The slice of Git smart-HTTP the mirror speaks: one receive-pack (protocol
// v1) request and its report-status reply. Pure bytes in, bytes out.

export const ZERO_SHA = "0".repeat(40);

const PKT_LENGTH_DIGITS = 4;
const PKT_RADIX = 16;
const PKT_FLUSH_LENGTH = 0;
const PKT_FLUSH = "0000";
const AGENT = "corpus-mirror";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function pktLine(text: string): Bytes {
  const payload = encoder.encode(text);
  return concatBytes([
    encoder.encode(
      (payload.length + PKT_LENGTH_DIGITS)
        .toString(PKT_RADIX)
        .padStart(PKT_LENGTH_DIGITS, "0"),
    ),
    payload,
  ]);
}

// Lines of a pkt-line stream; a flush packet is `null`.
export function parsePktLines(bytes: Uint8Array): readonly (string | null)[] {
  const lines: (string | null)[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const length = Number.parseInt(
      decoder.decode(bytes.subarray(offset, offset + PKT_LENGTH_DIGITS)),
      PKT_RADIX,
    );
    if (Number.isNaN(length) || length === 1 || length === 2 || length === 3) {
      throw new InternalError("malformed pkt-line in the Git response");
    }
    if (length === PKT_FLUSH_LENGTH) {
      lines.push(null);
      offset += PKT_LENGTH_DIGITS;
      continue;
    }
    if (offset + length > bytes.length) {
      throw new InternalError("truncated pkt-line in the Git response");
    }
    lines.push(
      decoder.decode(
        bytes.subarray(offset + PKT_LENGTH_DIGITS, offset + length),
      ),
    );
    offset += length;
  }
  return lines;
}

export type RefUpdate = Readonly<{
  ref: string;
  oldSha: string;
  newSha: string;
}>;

// `<old> <new> <ref>\0 report-status agent=…`, a flush, then the pack.
export function receivePackRequest(update: RefUpdate, pack: Bytes): Bytes {
  const command = pktLine(
    `${update.oldSha} ${update.newSha} ${update.ref}\0 report-status agent=${AGENT}\n`,
  );
  return concatBytes([command, encoder.encode(PKT_FLUSH), pack]);
}

export type RefReport = Readonly<{ ok: true } | { ok: false; reason: string }>;

export type ReportStatus = Readonly<{
  // `ok` or the receiver's reason it could not unpack the pack.
  unpack: string;
  refs: ReadonlyMap<string, RefReport>;
}>;

const UNPACK_PREFIX = "unpack ";
const OK_PREFIX = "ok ";
const REJECTED_PREFIX = "ng ";

// A rejected push is still an HTTP 200: the verdict is only in this body
// (`ng refs/heads/main <reason>`), so a caller that checks the status code
// alone would call a refused push a success.
export function parseReportStatus(body: Uint8Array): ReportStatus {
  let unpack: string | undefined;
  const refs = new Map<string, RefReport>();
  for (const line of parsePktLines(body)) {
    if (line === null) continue;
    const text = line.replace(/\n$/u, "");
    if (text.startsWith(UNPACK_PREFIX)) {
      unpack = text.slice(UNPACK_PREFIX.length);
    } else if (text.startsWith(OK_PREFIX)) {
      refs.set(text.slice(OK_PREFIX.length), { ok: true });
    } else if (text.startsWith(REJECTED_PREFIX)) {
      const rest = text.slice(REJECTED_PREFIX.length);
      const split = rest.indexOf(" ");
      const ref = split === -1 ? rest : rest.slice(0, split);
      const reason = split === -1 ? "" : rest.slice(split + 1);
      refs.set(ref, { ok: false, reason });
    }
  }
  if (unpack === undefined) {
    throw new InternalError("the Git response carried no report-status");
  }
  return { unpack, refs };
}
