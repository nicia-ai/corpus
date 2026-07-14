import {
  asCollectionSlug,
  asDocumentSlug,
  asFolderSlug,
  type DocumentSlug,
} from "../../ids";
import {
  type AppliedFrom,
  collectionFolderTreeChanged,
  documentArchived,
  documentChange,
  documentDetached,
  documentFilenameChanged,
  documentRenamed,
} from "../../store/domain/change-events";
import {
  frontmatterTitle,
  parseFrontmatter,
} from "../../store/domain/frontmatter";
import {
  basename,
  defaultFilename,
  normalizeSlug,
  pathSegments,
  stripExtension,
} from "../../store/domain/paths";
import { nextVersion } from "../../store/domain/versioning";
import { documentVersion } from "../../store/domain/versions";
import { inferTitle } from "../../util";
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
} from "../contracts";

import { maintainAnchorsOnSave } from "./anchoring";
import { folderTreeFanOutChanges } from "./folder-fanout";

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
// case: a caller-supplied filename on a brand-new document collides with
// an existing sibling's filename at the project root.
export class FilenameCollision extends Error {
  constructor() {
    super("segment-collision");
    this.name = "FilenameCollision";
  }
}

export type SaveDocumentCommandInput = Readonly<{
  slug: DocumentSlug;
  markdown: string;
  title?: string;
  filename?: string;
  // The folder this document lives in (null = project root). Scopes the
  // brand-new-filename collision check to the correct sibling namespace,
  // since filename uniqueness is per-folder (the path is folder ancestry +
  // filename), not global. Defaults to root for the editor / REST-create
  // paths, which never folder-place; the import path passes its resolved
  // target folder.
  folderSlug?: string | null;
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
  const contentHash = await ctx.hash(input.markdown);
  const head = await ctx.u.docs.find(input.slug);
  const filename =
    input.filename ?? head?.filename ?? defaultFilename(input.slug);
  // Only a brand-new document with a caller-chosen (not auto-derived)
  // filename can collide: the auto-default is always free (it's derived
  // from the already-unique slug), and an existing document keeps its own
  // filename slot unless renamed via renameFilenameCommand, which already
  // guards this. The collision scope is the document's own folder sibling
  // namespace (root for editor/REST create; the resolved target folder for
  // a folder-placed import) — filename uniqueness is per-folder, not global.
  if (head === undefined && input.filename !== undefined) {
    const occupant = await ctx.u.folders.documentAt(
      input.folderSlug ?? null,
      filename,
    );
    if (occupant !== undefined) throw new FilenameCollision();
  }
  const parsed = parseFrontmatter(input.markdown);
  const body = parsed.ok ? parsed.body : input.markdown;
  const fmTitle = parsed.ok ? frontmatterTitle(parsed.frontmatter) : undefined;
  const title =
    input.title ?? fmTitle ?? inferTitle(body, stripExtension(filename));
  const docVersion = nextVersion(head, input.clientVersion);
  await ctx.u.blobs.put(contentHash, input.markdown, ctx.now);
  const node = await ctx.u.docs.put(
    input.slug,
    { title, filename, contentHash, docVersion, updatedAt: ctx.now },
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
  await ctx.u.docs.rename(node, input.title, ctx.now);
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
  const fanout = await folderTreeFanOutChanges(ctx.u, input.changedBy, ctx.now);
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

  const folderAncestors = await ctx.u.folders.documentFolderAncestorSlugs(
    input.slug,
  );
  await ctx.u.docs.archive(node, ctx.now);
  const changes: DomainChange[] = [];
  const directHandled = new Set<string>();

  for (const cs of await ctx.u.cols.collectionsIncluding(input.slug)) {
    const collectionSlug = asCollectionSlug(cs);
    const position = await ctx.u.cols.detach(collectionSlug, input.slug);
    if (position === undefined) continue;
    await ctx.collection.snapshot(
      ctx.u,
      collectionSlug,
      input.changedBy,
      ctx.now,
    );
    directHandled.add(collectionSlug);
    changes.push(
      documentDetached({
        collectionSlug,
        documentSlug: input.slug,
        position,
        changedBy: input.changedBy,
        changedAt: ctx.now,
      }),
    );
  }

  if (folderAncestors.length > 0) {
    const folderLinked =
      await ctx.u.cols.collectionsIncludingFolders(folderAncestors);
    for (const cs of folderLinked) {
      if (directHandled.has(cs)) continue;
      const collectionSlug = asCollectionSlug(cs);
      await ctx.collection.snapshot(
        ctx.u,
        collectionSlug,
        input.changedBy,
        ctx.now,
      );
      changes.push(
        collectionFolderTreeChanged({
          collectionSlug,
          changedBy: input.changedBy,
          changedAt: ctx.now,
        }),
      );
    }
  }

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

export async function importDocumentAtPathCommand(
  ctx: ProjectCommandContext,
  input: Readonly<{ path: string; markdown: string; changedBy: string }>,
): Promise<CommandOutcome<ImportDocResult>> {
  const segments = pathSegments(input.path);
  const filename = basename(input.path);
  if (filename === "" || segments.length === 0) {
    return {
      result: { ok: false, reason: "invalid-path" },
      changes: [],
    };
  }
  const dir = segments.slice(0, -1);
  const ensured = await ctx.u.folders.ensureFolderPath(
    dir,
    ctx.now,
    (name, taken) => asFolderSlug(normalizeSlug(name, taken)),
  );
  if (!ensured.ok) throw new ImportAbort(ensured.reason);
  const folderSlug = ensured.folderSlug;

  const existing = await ctx.u.folders.documentAt(folderSlug, filename);
  let slug: DocumentSlug;
  let created: boolean;
  if (existing !== undefined) {
    slug = asDocumentSlug(existing.slug);
    created = false;
  } else {
    const taken = new Set((await ctx.u.docs.listAll()).map((d) => d.slug));
    slug = asDocumentSlug(normalizeSlug(input.path, taken));
    created = true;
  }

  const head = await ctx.u.docs.find(slug);
  const saved = await saveDocumentCommand(ctx, {
    slug,
    markdown: input.markdown,
    filename,
    folderSlug,
    clientVersion: head?.docVersion ?? 0,
    changedBy: input.changedBy,
  });
  const placed = await ctx.u.folders.placeDocument(slug, folderSlug);
  if (!placed.ok) throw new ImportAbort("segment-collision");
  return {
    result: {
      ok: true,
      slug,
      docVersion: saved.result.docVersion,
      created,
      folderSlug,
      createdFolders: ensured.created,
    },
    changes: saved.changes,
  };
}
