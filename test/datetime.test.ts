import { describe, expect, it } from "vitest";

import { recentTime, relativeTime } from "../src/lib/datetime";

const EDITED_AT = "2026-09-24T12:00:00.000Z";
const EDITED_MS = Date.parse(EDITED_AT);

describe("recentTime", () => {
  it.each([
    [0, "just now"],
    [4_999, "just now"],
    [5_000, "5s ago"],
    [20_400, "20s ago"],
    [59_999, "59s ago"],
    [60_000, "1m ago"],
    [3 * 60 * 60_000, "3h ago"],
  ])("%ims after the edit reads %s", (elapsed, expected) => {
    expect(recentTime(EDITED_AT, EDITED_MS + elapsed)).toBe(expected);
  });

  it("clamps a client clock that runs behind the server to just now", () => {
    expect(recentTime(EDITED_AT, EDITED_MS - 30_000)).toBe("just now");
  });

  it("returns an unparseable timestamp unchanged", () => {
    expect(recentTime("not a date", EDITED_MS)).toBe("not a date");
  });
});

describe("relativeTime", () => {
  it("keeps minute granularity under a minute", () => {
    expect(relativeTime(EDITED_AT, EDITED_MS + 20_000)).toBe("just now");
  });
});
