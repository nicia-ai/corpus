import { describe, expect, it } from "vitest";

import {
  hrefToDocSlug,
  isExternalHref,
  isSafeExternalHref,
} from "@/lib/doc-href";

// isExternalHref only decides "not an in-project doc link" — an active
// scheme like javascript:/data: is external too, so it must never reach
// window.open. isSafeExternalHref is the separate, narrower gate for that.
describe("isSafeExternalHref", () => {
  it("allows http(s), mailto, tel, and protocol-relative targets", () => {
    expect(isSafeExternalHref("https://example.com")).toBe(true);
    expect(isSafeExternalHref("http://example.com")).toBe(true);
    expect(isSafeExternalHref("mailto:a@example.com")).toBe(true);
    expect(isSafeExternalHref("tel:+15551234567")).toBe(true);
    expect(isSafeExternalHref("//example.com/path")).toBe(true);
  });

  it("rejects active schemes a malicious document could embed", () => {
    expect(isSafeExternalHref("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalHref("data:text/html,<script>alert(1)</script>")).toBe(
      false,
    );
    expect(isSafeExternalHref("vbscript:msgbox(1)").valueOf()).toBe(false);
  });

  it("agrees with isExternalHref on what counts as external", () => {
    for (const href of ["javascript:alert(1)", "https://example.com"]) {
      expect(isExternalHref(href)).toBe(true);
    }
  });
});

describe("hrefToDocSlug", () => {
  it("resolves a schemeless target to a bare slug", () => {
    expect(hrefToDocSlug("/documents/readme.md")).toBe("readme");
    expect(hrefToDocSlug("readme.md?x=1#y")).toBe("readme");
  });
});
