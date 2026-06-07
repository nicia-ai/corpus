import { describe, expect, it } from "vitest";

import {
  ClientMessage,
  presenceFrom,
  SocketAttachment,
} from "../src/project-store/presence";

describe("presence", () => {
  it("dedupes by (user, document) and drops anonymous sockets", () => {
    const users = presenceFrom([
      { userId: "u1", userName: "Alice", docSlug: "doc-a" },
      { userId: "u1", userName: "Alice", docSlug: "doc-a" }, // second tab
      { userId: "u1", userName: "Alice", docSlug: "doc-b" }, // other doc
      { userId: "u2", userName: "Bob", docSlug: "doc-a" },
      { userId: "", userName: "Someone", docSlug: "doc-a" }, // unauthed → dropped
    ]);
    expect(users).toHaveLength(3);
    expect(
      users.filter((u) => u.docSlug === "doc-a").map((u) => u.userId),
    ).toEqual(["u1", "u2"]);
  });

  it("validates the wire schemas", () => {
    expect(
      ClientMessage.safeParse({ type: "viewing", docSlug: "x" }).success,
    ).toBe(true);
    expect(ClientMessage.safeParse({ type: "nope" }).success).toBe(false);
    expect(
      SocketAttachment.safeParse({
        userId: "u",
        userName: "n",
        docSlug: null,
      }).success,
    ).toBe(true);
  });
});
