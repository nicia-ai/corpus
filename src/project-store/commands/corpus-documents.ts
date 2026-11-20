import { ConflictError, ValidationError } from "../../errors";
import {
  asDocumentSlug,
  asFolderSlug,
  type CorpusSlug,
  type DocumentSlug,
} from "../../ids";
import { documentFilenameChanged } from "../../store/domain/change-events";
import { normalizeSlug } from "../../store/domain/paths";
import type { CommandOutcome, ProjectCommandContext } from "../command";
import type { SaveDocumentInput } from "../contracts";

import { corpusOfDocument, corpusTreeChanged } from "./corpus-tree";
import {
  archiveOneDocumentCommand,
  createInCorpusAtPathCommand,
  FilenameCollision,
} from "./documents";
import { checkedPathSegments } from "./untrusted-path";

// The corpus-scoped document operations behind the key-authenticated REST
// surface. Each re-checks, INSIDE the write, that the document is in the
// bound corpus now — a membership snapshot taken earlier in the request
// never widens the scope.

type CreatedAtPath = Readonly<
  { ok: true; slug: DocumentSlug; docVersion: number } | { ok: false }
>;

// Create a NEW document at a corpus-relative path, deriving its slug the way
// create-proposals do (steering around every taken slug, archived ones
// included). `ok: false` = the corpus is gone and nothing was written.
export async function createDocumentAtPathCommand(
  ctx: ProjectCommandContext,
  input: Omit<SaveDocumentInput, "slug" | "clientVersion" | "location"> &
    Readonly<{ corpusSlug: CorpusSlug; path: string }>,
): Promise<CommandOutcome<CreatedAtPath>> {
  const taken = new Set((await ctx.u.docs.listAll()).map((d) => d.slug));
  const slug = asDocumentSlug(normalizeSlug(input.path, taken));
  const created = await createInCorpusAtPathCommand(ctx, {
    ...input,
    slug,
    clientVersion: 0,
  });
  return created.result === undefined
    ? { result: { ok: false }, changes: [] }
    : {
        result: { ok: true, slug, docVersion: created.result.docVersion },
        changes: created.changes,
      };
}

type ArchivedInCorpus = Readonly<{ archived: boolean }>;

// Remove a document from its corpus by archiving it (the soft delete every
// removal gets). `clientVersion` is the version the caller last saw: if the
// document moved on, the removal is refused (a `ConflictError`) rather than
// discarding an edit the caller never saw. `archived: false` = no such live
// document in this corpus.
export async function archiveDocumentInCorpusCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    slug: DocumentSlug;
    corpusSlug: CorpusSlug;
    clientVersion: number;
    changedBy: string;
  }>,
): Promise<CommandOutcome<ArchivedInCorpus>> {
  const head = await ctx.u.docs.find(input.slug);
  if (
    head === undefined ||
    head.archivedAt !== undefined ||
    (await corpusOfDocument(ctx.u, input.slug)) !== input.corpusSlug
  ) {
    return { result: { archived: false }, changes: [] };
  }
  if (head.docVersion !== input.clientVersion) {
    throw new ConflictError(head.docVersion);
  }
  return archiveOneDocumentCommand(ctx, {
    slug: input.slug,
    changedBy: input.changedBy,
  });
}

type MovedToPath = Readonly<
  { ok: true; changed: boolean } | { ok: false; reason: "missing" }
>;

// Move a document to a corpus-relative path (folder chain + file name) in
// the SAME corpus, keeping its history: nothing but the folder edge and the
// `filename` changes. A name already taken at the destination throws
// `FilenameCollision` so folders created on the way roll back with it.
export async function moveDocumentToPathCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    slug: DocumentSlug;
    corpusSlug: CorpusSlug;
    path: string;
    changedBy: string;
  }>,
): Promise<CommandOutcome<MovedToPath>> {
  const missing = { result: { ok: false, reason: "missing" } } as const;
  const head = await ctx.u.docs.find(input.slug);
  if (
    head === undefined ||
    head.archivedAt !== undefined ||
    (await corpusOfDocument(ctx.u, input.slug)) !== input.corpusSlug
  ) {
    return { ...missing, changes: [] };
  }
  const segments = checkedPathSegments(input.path);
  const filename = segments.at(-1);
  if (filename === undefined) {
    throw new ValidationError("A path must name a file.");
  }
  const rootSlug = await ctx.u.cols.rootFolderSlug(input.corpusSlug);
  if (rootSlug === undefined) return { ...missing, changes: [] };
  const ensured = await ctx.u.folders.ensureFolderPath(
    rootSlug,
    segments.slice(0, -1),
    ctx.now,
    (name, taken) => asFolderSlug(normalizeSlug(name, taken)),
  );
  if (!ensured.ok) throw new FilenameCollision();
  const placed = await ctx.u.folders.relocate(
    input.slug,
    ensured.folderSlug,
    filename,
  );
  if (!placed.ok) {
    if (placed.reason === "segment-collision") throw new FilenameCollision();
    return { ...missing, changes: [] };
  }
  if (!placed.changed)
    return { result: { ok: true, changed: false }, changes: [] };
  const renamed = head.filename !== filename;
  if (renamed) await ctx.u.docs.setFilename(head, filename, ctx.now);
  return {
    result: { ok: true, changed: true },
    changes: [
      ...(renamed
        ? [
            documentFilenameChanged({
              slug: input.slug,
              docVersion: head.docVersion,
              title: head.title,
              changedBy: input.changedBy,
              changedAt: ctx.now,
            }),
          ]
        : []),
      ...(await corpusTreeChanged(
        ctx,
        [input.corpusSlug],
        input.changedBy,
        "paths",
      )),
    ],
  };
}
