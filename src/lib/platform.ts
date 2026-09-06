// Best-effort Mac detection for keyboard-shortcut labels (⌘ vs Ctrl).
// `userAgentData.platform` is the modern signal but Chromium-only; the
// deprecated `navigator.platform` remains the only cross-browser fallback, so
// we try both before giving up and assuming non-Mac. The platform can't
// change mid-session, so the result is cached after the first real (client)
// call — modKeyLabel() is read per link on every live-preview decoration
// recompute (every keystroke/selection change near a link), and re-probing
// navigator plus re-running the regex on each of those would be pure waste.
// The SSR fallback (no `navigator`) is deliberately left uncached so a later
// client-side call still resolves the real platform.
let macPlatform: boolean | undefined;

export function isMacPlatform(): boolean {
  if (macPlatform !== undefined) return macPlatform;
  if (typeof navigator === "undefined") return false;
  const uaData = (navigator as { userAgentData?: { platform?: string } })
    .userAgentData;
  const platform = uaData?.platform ?? navigator.platform;
  macPlatform = /mac/i.test(platform);
  return macPlatform;
}

// The modifier key that follows a link from inside the live-preview editor
// (see MarkdownEditor's mousedown handler): Cmd on macOS, Ctrl elsewhere.
export function modKeyLabel(): string {
  return isMacPlatform() ? "⌘" : "Ctrl";
}
