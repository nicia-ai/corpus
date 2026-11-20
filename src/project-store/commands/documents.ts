import {
  asDocumentSlug,
  asFolderSlug,
  type CorpusSlug,
  type DocumentSlug,
  type FolderSlug,
} from "../../ids";
import {
  type AppliedFrom,
  documentArchived,
  documentChange,
  documentFilenameChanged,
  documentRenamed,
} from "../../store/domain/change-events";
import { DEFAULT_CORPUS_SLUG } from "../../store/domain/default-corpus";
import { resolveTitle } from "../../store/domain/frontmatter";
import {
  basename,
  defaultFilename,
  normalizeSlug,
  stripExtension,
} from "../../store/domain/paths";
import { deriveSearchText } from "../../store/domain/search";
import { nextVersion } from "../../store/domain/versioning";
import { documentVersion } from "../../store/domain/versions";
import { markdownTooLarge } from "../../util";
import type {
  CommandOutcome,
  DomainChange,
  ProjectCommandContext,
} from "../command";
import type {
  ImportDocResult,
  RenameDocumentInput,
  RenameFilenameInput,
  RenameFilenameResult,
  SaveDocumentInput,
} from "../contracts";

import { maintainAnchorsOnSave } from "./anchoring";
import {
  corpusOfDocument,
  corpusTreeChanged,
  resolveCorpusFolder,
} from "./corpus-tree";
import { ensureDefaultCorpusCommand } from "./ensure-default-corpus";
import { checkedPathSegments } from "./untrusted-path";

// Internal control-flow sentinel: thrown inside the import write() to
// abort (roll back) the whole atomic unit on a folder/document segment
// collision, then mapped to a result at the DO boundary. Deliberately
// NOT an AppError (same rationale as RollbackProbe — never surfaced).
export class ImportAbort extends Error {
  constructor(readonly reason: "segment-collision") {
    super(reason);
    this.name = "ImportAbort";
  }
}

// Same sentinel pattern as ImportAbort, for saveDocumentCommand's narrower
// case: a brand-new document's filename collides with an existing sibling
// segment in the folder it is being created in.
export class FilenameCollision extends Error {
  constructor() {
    super("segment-collision");
    this.name = "FilenameCollision";
  }
}

// Same sentinel pattern again: markdown over MAX_MARKDOWN_BYTES. The DO
// boundary maps it to a structured result before any transport sees it.
// Enforced HERE — the single creation chokepoint every write funnels
// through — because DO SQLite has a hard ~2MB per-value limit; without
// this guard an oversized blob dies mid-transaction as an opaque
// storage-layer error.
export class MarkdownTooLarge extends Error {
  constructor() {
    super("markdown too large");
    this.name = "MarkdownTooLarge";
  }
}

export type SaveDocumentCommandInput = Readonly<{
  slug: DocumentSlug;
  markdown: string;
  title?: string;
  filename?: string;
  // Where a NEW document is created — required when there is no head,
  // because a document never exists outside a corpus: creation and
  // placement are one step. Always a folder under a corpus root (callers
  // resolve it through `resolveCorpusFolder`). Inert on an update.
  folderSlug?: FolderSlug;
  clientVersion: number;
  changedBy: string;
  // Set only by the apply-suggestion path: the durable origin recorded on
  // this save's change event (`changedBy` stays the human approver).
  appliedFrom?: AppliedFrom;
  __failAfterWrites?: boolean;
}>;

export type SaveDocumentCommandResult = Readonly<{
  docVersion: number;
}>;

export async function saveDocumentCommand(
  ctx: ProjectCommandContext,
  input: SaveDocumentCommandInput,
): Promise<CommandOutcome<SaveDocumentCommandResult>> {
  if (markdownTooLarge(input.markdown)) throw new MarkdownTooLarge();
  const contentHash = await ctx.hash(input.markdown);
  const head = await ctx.u.docs.find(input.slug);
  const filename =
    input.filename ?? head?.filename ?? defaultFilename(input.slug);
  // An existing document keeps its own filename slot unless renamed via
  // renameFilenameCommand, which guards that itself. A new one must find
  // its slot free in the folder it is created in — checked before any
  // write so the failure path writes nothing.
  if (head === undefined) {
    if (input.folderSlug === undefined) {
      throw new Error("a new document must be created in a corpus folder");
    }
    if (await ctx.u.folders.slotOccupied(input.folderSlug, filename)) {
      throw new FilenameCollision();
    }
  }
  const title = resolveTitle({
    markdown: input.markdown,
    fallback: stripExtension(filename),
    override: input.title,
  });
  const docVersion = nextVersion(head, input.clientVersion);
  // A brand-new document claims its slug: any open create-proposal for the
  // same slug is now off-base, exactly like an edit suggestion whose head
  // moved. saveDocumentCommand is the single creation chokepoint (editor,
  // REST create, import, apply-create), so the stale rule lives here once.
  // The apply-create path stales itself here too, then records its own
  // terminal `applied` status afterwards — deliberate ordering.
  if (head === undefined) {
    await ctx.u.suggestions.staleOpenForDoc(input.slug);
  }
  await ctx.u.blobs.put(contentHash, input.markdown, ctx.now);
  const node = await ctx.u.docs.put(
    input.slug,
    {
      title,
      filename,
      contentHash,
      docVersion,
      updatedAt: ctx.now,
      // A save doesn't unarchive; an archived head must stay out of the index.
      searchText:
        head?.archivedAt !== undefined
          ? ""
          : deriveSearchText(title, input.markdown),
    },
    head,
  );
  await ctx.u.versions.appendDocumentVersion(
    node.id,
    documentVersion({
      slug: input.slug,
      docVersion,
      contentHash,
      prevContentHash: head?.contentHash,
      changedAt: ctx.now,
      changedBy: input.changedBy,
    }),
  );
  if (head === undefined && input.folderSlug !== undefined) {
    await ctx.u.folders.rehomeDocument(input.slug, input.folderSlug);
  }
  // Maintain block ids + rebase open comment anchors onto this new version,
  // in the same transaction (no-op unless the document has open threads).
  await maintainAnchorsOnSave(ctx, {
    slug: input.slug,
    docVersion,
    markdown: input.markdown,
    head,
  });
  const change = documentChange({
    existed: head !== undefined,
    slug: input.slug,
    docVersion,
    title,
    contentHash,
    changedBy: input.changedBy,
    changedAt: ctx.now,
    ...(input.appliedFrom !== undefined
      ? { appliedFrom: input.appliedFrom }
      : {}),
  });
  return {
    result: { docVersion },
    changes: [change],
    rollbackAfterRecord: input.__failAfterWrites === true,
  };
}

export type SaveOrCreateResult = Readonly<
  { docVersion: number } | { unknownLocation: true }
>;

// The web / REST save entry. An existing document is a plain save. A new
// one is created at `location` (the default corpus's root when none is
// given — the drafts space, materialized on demand), and the corpus it
// joined gets a fresh snapshot. `unknownLocation` = the named corpus or
// folder does not exist (nothing is written).
export async function saveOrCreateDocumentCommand(
  ctx: ProjectCommandContext,
  input: SaveDocumentInput,
): Promise<CommandOutcome<SaveOrCreateResult>> {
  if ((await ctx.u.docs.find(input.slug)) !== undefined) {
    return saveDocumentCommand(ctx, input);
  }
  const location = input.location ?? {
    corpusSlug: DEFAULT_CORPUS_SLUG,
    folderSlug: null,
  };
  const ensured =
    location.corpusSlug === DEFAULT_CORPUS_SLUG
      ? await ensureDefaultCorpusCommand(ctx, input.changedBy)
      : undefined;
  const folderSlug = await resolveCorpusFolder(ctx.u, location);
  if (folderSlug === undefined) {
    return { result: { unknownLocation: true }, changes: [] };
  }
  const saved = await saveDocumentCommand(ctx, { ...input, folderSlug });
  return {
    ...saved,
    changes: [
      ...(ensured?.changes ?? []),
      ...saved.changes,
      ...(await corpusTreeChanged(
        ctx,
        [location.corpusSlug],
        input.changedBy,
        "membership",
      )),
    ],
  };
}

export async function renameDocumentCommand(
  ctx: ProjectCommandContext,
  input: RenameDocumentInput,
): Promise<
  CommandOutcome<Readonly<{ status: "missing" | "noop" | "changed" }>>
> {
  const node = await ctx.u.docs.find(input.slug);
  if (node === undefined) {
    return { result: { status: "missing" }, changes: [] };
  }
  if (node.title === input.title) {
    return { result: { status: "noop" }, changes: [] };
  }
  // Title is part of the fulltext content; recompute `searchText` against the
  // unchanged body (the rename doesn't touch the blob). An archived doc stays
  // out of the index — keep its `searchText` empty rather than resurrect it.
  const searchText =
    node.archivedAt !== undefined
      ? ""
      : deriveSearchText(
          input.title,
          (await ctx.u.blobs.get(node.contentHash)) ?? "",
        );
  await ctx.u.docs.rename(node, input.title, searchText, ctx.now);
  const change = documentRenamed({
    slug: input.slug,
    docVersion: node.docVersion,
    title: input.title,
    changedBy: input.changedBy,
    changedAt: ctx.now,
  });
  return {
    result: { status: "changed" },
    changes: [change],
  };
}

export async function renameFilenameCommand(
  ctx: ProjectCommandContext,
  input: RenameFilenameInput,
): Promise<CommandOutcome<RenameFilenameResult>> {
  const node = await ctx.u.docs.find(input.slug);
  if (node === undefined) {
    return {
      result: { ok: false, reason: "missing" },
      changes: [],
    };
  }
  if (node.filename === input.filename) {
    return {
      result: { ok: true },
      changes: [],
    };
  }
  if (!(await ctx.u.folders.filenameAvailable(input.slug, input.filename))) {
    return {
      result: { ok: false, reason: "segment-collision" },
      changes: [],
    };
  }
  await ctx.u.docs.setFilename(node, input.filename, ctx.now);
  const change = documentFilenameChanged({
    slug: input.slug,
    docVersion: node.docVersion,
    title: node.title,
    changedBy: input.changedBy,
    changedAt: ctx.now,
  });
  const corpusSlug = await corpusOfDocument(ctx.u, input.slug);
  const fanout =
    corpusSlug === undefined
      ? []
      : await corpusTreeChanged(ctx, [corpusSlug], input.changedBy, "paths");
  return {
    result: { ok: true },
    changes: [change, ...fanout],
  };
}

export type ArchiveOneDocumentResult = Readonly<{
  archived: boolean;
}>;

export async function archiveOneDocumentCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{ slug: DocumentSlug; changedBy: string }>,
): Promise<CommandOutcome<ArchiveOneDocumentResult>> {
  const node = await ctx.u.docs.find(input.slug);
  if (node === undefined || node.archivedAt !== undefined) {
    return { result: { archived: false }, changes: [] };
  }

  // Read before archiving: an archived document keeps its folder, but the
  // corpus it leaves must be known to snapshot it without the document.
  const corpusSlug = await corpusOfDocument(ctx.u, input.slug);
  await ctx.u.docs.archive(node, ctx.now);
  const changes: DomainChange[] =
    corpusSlug === undefined
      ? []
      : [
          ...(await corpusTreeChanged(
            ctx,
            [corpusSlug],
            input.changedBy,
            "membership",
          )),
        ];

  changes.push(
    documentArchived({
      slug: input.slug,
      docVersion: node.docVersion,
      title: node.title,
      changedBy: input.changedBy,
      changedAt: ctx.now,
    }),
  );
  return { result: { archived: true }, changes };
}

export async function archiveDocumentsCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{ slugs: readonly DocumentSlug[]; changedBy: string }>,
): Promise<CommandOutcome<{ archived: number }>> {
  const changes: DomainChange[] = [];
  let archived = 0;
  for (const slug of input.slugs) {
    const r = await archiveOneDocumentCommand(ctx, {
      slug,
      changedBy: input.changedBy,
    });
    if (r.result.archived) archived += 1;
    changes.push(...r.changes);
  }
  return { result: { archived }, changes };
}

// One uploaded file, at a path relative to `corpusSlug`'s root. Missing
// folders are created under the root; a path already holding a live
// document becomes a new version of it. The caller snapshots the corpus
// once for the whole upload.
export async function importDocumentAtPathCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{
    corpusSlug: CorpusSlug;
    path: string;
    markdown: string;
    changedBy: string;
  }>,
): Promise<CommandOutcome<ImportDocResult>> {
  const segments = checkedPathSegments(input.path);
  const filename = basename(input.path);
  if (filename === "" || segments.length === 0) {
    return { result: { ok: false, reason: "invalid-path" }, changes: [] };
  }
  const rootSlug = await ctx.u.cols.rootFolderSlug(input.corpusSlug);
  if (rootSlug === undefined) {
    return { result: { ok: false, reason: "missing-corpus" }, changes: [] };
  }
  const ensured = await ctx.u.folders.ensureFolderPath(
    rootSlug,
    segments.slice(0, -1),
    ctx.now,
    (name, taken) => asFolderSlug(normalizeSlug(name, taken)),
  );
  if (!ensured.ok) throw new ImportAbort(ensured.reason);
  const folderSlug = ensured.folderSlug;

  const existing = await ctx.u.folders.documentAt(folderSlug, filename);
  let slug: DocumentSlug;
  if (existing !== undefined) {
    slug = asDocumentSlug(existing.slug);
  } else {
    const taken = new Set((await ctx.u.docs.listAll()).map((d) => d.slug));
    slug = asDocumentSlug(normalizeSlug(input.path, taken));
  }
  let saved;
  try {
    saved = await saveDocumentCommand(ctx, {
      slug,
      markdown: input.markdown,
      filename,
      folderSlug,
      clientVersion: existing?.docVersion ?? 0,
      changedBy: input.changedBy,
    });
  } catch (err) {
    if (err instanceof FilenameCollision) {
      throw new ImportAbort("segment-collision");
    }
    throw err;
  }
  return {
    result: {
      ok: true,
      slug,
      docVersion: saved.result.docVersion,
      created: existing === undefined,
    },
    changes: saved.changes,
  };
}
