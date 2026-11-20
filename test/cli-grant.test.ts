import { describe, expect, it } from "vitest";

import { CLI_GRANTS, grantAllows as cliAllows } from "../cli/grant";
import { GRANTS, grantAllows } from "../src/grant";

// The CLI package is published standalone, so it mirrors the server's grant
// vocabulary. This is the only thing keeping the two from drifting.
describe("the CLI's mirror of the grant rule", () => {
  it("has the same grants in the same order", () => {
    expect(CLI_GRANTS).toEqual(GRANTS);
  });

  it("allows exactly what the server allows", () => {
    for (const held of GRANTS) {
      for (const needed of GRANTS) {
        expect(cliAllows(held, needed), `${held} -> ${needed}`).toBe(
          grantAllows(held, needed),
        );
      }
    }
  });
});
