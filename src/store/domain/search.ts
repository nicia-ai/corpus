// Pure, zero-IO search-snippet extraction. Given a body and the index of a
// match, produce a short display window around it with the match's offsets
// INSIDE the returned snippet, so the UI can emphasize the matched span
// without re-searching (a case-insensitive re-search client-side could hit
// a different occurrence). Newlines/tabs are replaced 1:1 with spaces —
// length-preserving, so the offsets stay valid — and trimmed edges gain an
// ellipsis that the offsets account for.

export type SearchSnippet = Readonly<{
  snippet: string;
  /** Match offsets within `snippet`; absent for a windowed preview with no
   * in-window match (e.g. a title-only hit previewing the body head). */
  matchStart?: number;
  matchEnd?: number;
}>;

const ELLIPSIS = "…";
// How far the window extends on each side of the match.
const SNIPPET_RADIUS = 60;
// How far an edge may move inward to land on a word boundary.
const BOUNDARY_SLACK = 16;

function flattenWhitespace(text: string): string {
  return text.replace(/[\n\r\t]/g, " ");
}

// Move `start` forward to just past the next space (within slack) so the
// window opens on a word boundary instead of mid-word.
function trimStartToBoundary(text: string, start: number): number {
  if (start === 0) return 0;
  const slack = text.slice(start, start + BOUNDARY_SLACK);
  const space = slack.indexOf(" ");
  return space === -1 ? start : start + space + 1;
}

function trimEndToBoundary(text: string, end: number): number {
  if (end >= text.length) return text.length;
  const from = Math.max(0, end - BOUNDARY_SLACK);
  const slack = text.slice(from, end);
  const space = slack.lastIndexOf(" ");
  return space === -1 ? end : from + space;
}

// A windowed preview of the body's start, used when the match is in the
// title and there is nothing in-body to point at.
export function headSnippet(body: string): SearchSnippet {
  const flat = flattenWhitespace(body);
  if (flat.length <= SNIPPET_RADIUS * 2) return { snippet: flat };
  const end = trimEndToBoundary(flat, SNIPPET_RADIUS * 2);
  return { snippet: flat.slice(0, end) + ELLIPSIS };
}

export function searchSnippet(
  body: string,
  matchIndex: number,
  matchLength: number,
): SearchSnippet {
  const flat = flattenWhitespace(body);
  const matchEndIndex = Math.min(matchIndex + matchLength, flat.length);
  let start = Math.max(0, matchIndex - SNIPPET_RADIUS);
  let end = Math.min(flat.length, matchEndIndex + SNIPPET_RADIUS);
  // Boundary-trim only the cut edges — never into the match itself.
  start = Math.min(trimStartToBoundary(flat, start), matchIndex);
  end = Math.max(trimEndToBoundary(flat, end), matchEndIndex);
  const prefix = start > 0 ? ELLIPSIS : "";
  const suffix = end < flat.length ? ELLIPSIS : "";
  return {
    snippet: prefix + flat.slice(start, end) + suffix,
    matchStart: prefix.length + (matchIndex - start),
    matchEnd: prefix.length + (matchEndIndex - start),
  };
}
