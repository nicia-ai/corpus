import { ValidationError } from "../../errors";
import { pathSegments } from "../../store/domain/paths";

const BACKSLASH = 0x5c;
const DELETE = 0x7f;
const FIRST_PRINTABLE = 0x20;

// A character no path may carry: a backslash (clients normalize to `/`
// before they send) or a control character.
export function isUnsafePathChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code < FIRST_PRINTABLE || code === DELETE || code === BACKSLASH;
}

const DRIVE_LETTER = /^[A-Za-z]:/u;

// `pathSegments` for a path that came from OUTSIDE (an upload, an agent
// proposal, REST): the one place an untrusted path is checked, so every
// transport inherits it. It must be relative to the corpus root and stay
// inside it, so `..` segments, absolute paths (`/x`, `C:…`), backslashes and
// control characters are a `ValidationError`; otherwise `.` and empty
// segments are dropped as `pathSegments` does.
export function checkedPathSegments(relativePath: string): string[] {
  if (
    Array.from(relativePath).some(isUnsafePathChar) ||
    relativePath.startsWith("/") ||
    DRIVE_LETTER.test(relativePath)
  ) {
    throw new ValidationError(
      "A path must be relative to the corpus, with no backslashes or control characters.",
    );
  }
  const segments = pathSegments(relativePath);
  if (segments.includes("..")) {
    throw new ValidationError("A path cannot contain “..”.");
  }
  return segments;
}
