import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applyHunks,
  diffToHunks,
  type Hunk,
} from "../src/store/domain/suggestion";

const PROPERTY_RUNS = { numRuns: 300, seed: 20260607 } as const;

type RenderKind = "paragraph" | "heading" | "list-item" | "code";

type BlockSpec = Readonly<{
  id: number;
  kind: RenderKind;
  revision: number;
}>;

type EditOp = Readonly<
  | { kind: "insert"; pos: number; blockKind: RenderKind }
  | { kind: "delete"; pos: number }
  | { kind: "replace"; pos: number; blockKind: RenderKind }
>;

type Scenario = Readonly<{
  base: string;
  proposed: string;
}>;

const renderKindArb = fc.constantFrom<RenderKind>(
  "paragraph",
  "heading",
  "list-item",
  "code",
);

const editOpArb: fc.Arbitrary<EditOp> = fc.oneof(
  fc.record({
    kind: fc.constant("insert"),
    pos: fc.nat(20),
    blockKind: renderKindArb,
  }),
  fc.record({ kind: fc.constant("delete"), pos: fc.nat(20) }),
  fc.record({
    kind: fc.constant("replace"),
    pos: fc.nat(20),
    blockKind: renderKindArb,
  }),
);

const baseKindsArb = fc.array(renderKindArb, {
  minLength: 1,
  maxLength: 8,
});

const editSequenceArb = fc.array(editOpArb, { minLength: 0, maxLength: 12 });

const scenarioArb = fc
  .record({
    baseKinds: baseKindsArb,
    ops: editSequenceArb,
  })
  .map(({ baseKinds, ops }) => buildScenario(baseKinds, ops));

function buildScenario(
  baseKinds: readonly RenderKind[],
  ops: readonly EditOp[],
): Scenario {
  let nextId = 0;
  const base: BlockSpec[] = baseKinds.map((kind) => ({
    id: nextId++,
    kind,
    revision: 0,
  }));
  const work: BlockSpec[] = [...base];

  for (const op of ops) {
    if (op.kind === "insert") {
      work.splice(Math.min(op.pos, work.length), 0, {
        id: nextId++,
        kind: op.blockKind,
        revision: 0,
      });
    } else if (op.kind === "delete" && work.length > 0) {
      work.splice(op.pos % work.length, 1);
    } else if (op.kind === "replace" && work.length > 0) {
      const index = op.pos % work.length;
      const current = work[index];
      if (current !== undefined) {
        work[index] = {
          id: current.id,
          kind: op.blockKind,
          revision: current.revision + 1,
        };
      }
    }
  }

  return {
    base: renderDoc(base),
    proposed: renderDoc(work),
  };
}

function renderDoc(blocks: readonly BlockSpec[]): string {
  return blocks.map(renderBlock).join("\n\n");
}

function blockText(block: BlockSpec): string {
  return [
    `block${block.id.toString()}`,
    `stable${block.id.toString()}`,
    `rev${block.revision.toString()}`,
    `marker${block.id.toString()}`,
    `kind-${block.kind}`,
  ].join(" ");
}

function renderBlock(block: BlockSpec): string {
  const text = blockText(block);
  switch (block.kind) {
    case "paragraph":
      return text;
    case "heading":
      return `## ${text}`;
    case "list-item":
      return `- ${text}`;
    case "code":
      return ["```txt", text, "", `${text} code-tail`, "```"].join("\n");
  }
}

function normalizeAppliedMarkdown(markdown: string): string {
  return collapseBlankRunsOutsideCode(markdown)
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
}

function collapseBlankRunsOutsideCode(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fence: string | undefined;
  let blankRun = 0;
  for (const line of lines) {
    const trimmed = line.trimStart();
    const run = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (fence === undefined) {
      if (run !== undefined) fence = run[0];
    } else if (run?.[0] === fence) {
      fence = undefined;
    }
    if (fence === undefined && line.trim() === "") {
      blankRun += 1;
      if (blankRun >= 2) continue;
    } else {
      blankRun = 0;
    }
    out.push(line);
  }
  return out.join("\n");
}

function subsetByMask(
  hunks: readonly Hunk[],
  mask: readonly boolean[],
): readonly Hunk[] {
  return hunks.filter((_, index) => mask[index % mask.length] ?? false);
}

describe("suggestion hunks (property)", () => {
  it("accept-all reproduces the proposed markdown after suggestion normalization", () => {
    fc.assert(
      fc.property(scenarioArb, ({ base, proposed }) => {
        const hunks = diffToHunks(base, proposed);
        expect(applyHunks(base, hunks)).toBe(
          normalizeAppliedMarkdown(proposed),
        );
      }),
      PROPERTY_RUNS,
    );
  });

  it("apply-none leaves a normalized suggestion document unchanged", () => {
    fc.assert(
      fc.property(scenarioArb, ({ base }) => {
        expect(applyHunks(base, [])).toBe(base);
      }),
      PROPERTY_RUNS,
    );
  });

  it("any accepted subset is well-formed, with empty and full subsets pinned", () => {
    fc.assert(
      fc.property(
        scenarioArb,
        fc.array(fc.boolean(), { maxLength: 24 }),
        ({ base, proposed }, mask) => {
          const hunks = diffToHunks(base, proposed);
          const subset = subsetByMask(hunks, mask);

          expect(() => applyHunks(base, subset)).not.toThrow();
          expect(typeof applyHunks(base, subset)).toBe("string");
          expect(applyHunks(base, [])).toBe(base);
          expect(applyHunks(base, hunks)).toBe(
            normalizeAppliedMarkdown(proposed),
          );
        },
      ),
      PROPERTY_RUNS,
    );
  });

  it("application is independent of hunk input order", () => {
    fc.assert(
      fc.property(scenarioArb, ({ base, proposed }) => {
        const hunks = diffToHunks(base, proposed);
        const reversed = [...hunks].reverse();

        expect(applyHunks(base, reversed)).toBe(applyHunks(base, hunks));
      }),
      PROPERTY_RUNS,
    );
  });

  it("no-op proposals produce no hunks", () => {
    fc.assert(
      fc.property(scenarioArb, ({ base }) => {
        expect(diffToHunks(base, base)).toEqual([]);
      }),
      PROPERTY_RUNS,
    );
  });
});
