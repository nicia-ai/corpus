import {
  asCollectionSlug,
  asDocumentSlug,
  asFolderSlug,
  type DocumentSlug,
} from "../../ids";
import {
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

export type SaveDocumentCommandInput = Readonly<{
  slug: DocumentSlug;
  markdown: string;
  title?: string;
  filename?: string;
  clientVersion: number;
  changedBy: string;
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
