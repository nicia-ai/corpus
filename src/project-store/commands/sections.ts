import { ConflictError } from "../../errors";
import {
  replaceSection,
  sectionUnchanged,
  type SectionTarget,
} from "../../store/domain/sections";
import type { CommandOutcome, ProjectCommandContext } from "../command";
import type {
  SaveSharedSectionInput,
  SaveSharedSectionResult,
} from "../contracts";

import { saveDocumentCommand } from "./documents";

// Replace one section of the head, atomically with the save. The splice always
// lands on the CURRENT head, so a stale `clientVersion` is safe exactly when
// the target section is byte-identical at the client's base and at the head:
// the other writer touched something else. When the base version has been
// reaped, or the section differs, the write is refused with a 409 and the
// caller re-reads. The version bump itself still goes through
// saveDocumentCommand's `nextVersion` gate against the head read here, so a
// write that interleaves between this read and the save is a 409 too.
export async function saveSectionCommand(
  ctx: ProjectCommandContext,
  input: SaveSharedSectionInput,
): Promise<CommandOutcome<SaveSharedSectionResult>> {
  const head = await ctx.u.docs.find(input.slug);
  if (head === undefined || head.archivedAt !== undefined) {
    return { result: { ok: false, missing: true }, changes: [] };
  }
  const headMarkdown = (await ctx.u.blobs.get(head.contentHash)) ?? "";
  const replaced = replaceSection(headMarkdown, input.target, input.body);
  if (!replaced.ok) {
    return {
      result:
        replaced.reason === "ambiguous"
          ? { ok: false, ambiguous: true, matches: replaced.matches }
          : { ok: false, invalidBody: true, error: replaced.error },
      changes: [],
    };
  }
  if (
    input.clientVersion !== head.docVersion &&
    !(await sectionUnchangedSince(ctx, {
      slug: input.slug,
      clientVersion: input.clientVersion,
      target: input.target,
      headMarkdown,
    }))
  ) {
    throw new ConflictError(head.docVersion);
  }
  const saved = await saveDocumentCommand(ctx, {
    slug: input.slug,
    markdown: replaced.markdown,
    clientVersion: head.docVersion,
    changedBy: input.changedBy,
  });
  return {
    ...saved,
    result: {
      ok: true,
      docVersion: saved.result.docVersion,
      created: replaced.created,
    },
  };
}

async function sectionUnchangedSince(
  ctx: ProjectCommandContext,
  input: Readonly<{
    slug: SaveSharedSectionInput["slug"];
    clientVersion: number;
    target: SectionTarget;
    headMarkdown: string;
  }>,
): Promise<boolean> {
  const base = await ctx.u.versions.documentVersion(
    input.slug,
    input.clientVersion,
  );
  if (base === undefined) return false;
  const baseMarkdown = await ctx.u.blobs.get(base.contentHash);
  if (baseMarkdown === undefined) return false;
  return sectionUnchanged(
    { before: baseMarkdown, after: input.headMarkdown },
    input.target,
  );
}
