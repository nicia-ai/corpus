import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { connectControlDb } from "@/control/db";
import { entitlementsOf } from "@/control/entitlements";
import { resolveUserNames } from "@/control/users";
import { ValidationError } from "@/errors";
import {
  asDocumentSlug,
  asFolderSlug,
  type DocumentSlug,
  type FolderSlug,
} from "@/ids";
import { projectMiddleware } from "@/lib/middleware";
import { changedBy, storeOf } from "@/lib/server/shared";
import { assertServerContext as srv } from "@/lib/server-context";
import { parseFrontmatter } from "@/store/domain/frontmatter";
import { compact, utf8Bytes } from "@/util";

// Plain, JSON-serializable shapes returned to loaders/components. Durable
// Object RPC returns carry non-serializable branding, so every handler
// maps to these explicitly (also gives loaders clean inferred types).
export type DocMeta = Readonly<{
  slug: DocumentSlug;
  title: string;
  docVersion: number;
  size: number;
}>;
// Documents list row: DocMeta plus how many distinct agent collections
// the document is attached to (the product's shared-linkage signal).
export type DocListItem = Readonly<{
  slug: DocumentSlug;
  title: string;
  docVersion: number;
  size: number;
  collectionCount: number;
  // Open suggestions awaiting review (agent or human proposals) — the
  // documents-list badge, the sibling of collectionCount.
  pendingSuggestions: number;
  filename: string;
  path: string;
  // Stable slug of the document's single home folder; null = project root.
  folderSlug: FolderSlug | null;
  updatedAt: string;
}>;
export type DocSnapshot = Readonly<{
  slug: DocumentSlug;
  title: string;
  filename: string;
  markdown: string;
  docVersion: number;
  updatedAt: string;
}>;
export type DocVersionEntry = Readonly<{
  docVersion: number;
  changedAt: string;
  changedBy: string;
  changedByName?: string;
  diffSummary?: string;
  markdown: string;
  retained: boolean;
}>;
export type DocVersionMeta = Omit<DocVersionEntry, "markdown">;
export type SaveResult = Readonly<
  | { ok: true; docVersion: number }
  | { ok: false; conflict: true; currentVersion: number }
  | { ok: false; segmentCollision: true }
  | { ok: false; rolledBack: true }
>;

export const docMetas = (
  rows: readonly {
    slug: string;
    title: string;
    docVersion: number;
    size: number;
  }[],
): DocMeta[] =>
  rows.map((d) => ({
    slug: asDocumentSlug(d.slug),
    title: d.title,
    docVersion: d.docVersion,
    size: d.size,
  }));

export const getDocuments = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .handler(async ({ context }): Promise<DocMeta[]> => {
    return docMetas(await storeOf(srv(context)).listDocuments());
  });

// The complete live slug + derived-path set — the editor's broken-link
// linter and wikilink resolution need every document (the documents list
// projection is capped; a partial set would flag real links as broken).
export type DocLinkRef = Readonly<{ slug: string; path: string }>;

export const getDocumentRefs = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .handler(async ({ context }): Promise<DocLinkRef[]> => {
    const refs = await storeOf(srv(context)).listDocumentRefs();
    return refs.map((r) => ({ slug: r.slug, path: r.path }));
  });

// One round trip for the documents list: heads + the flat attachment
// edge list, joined to a distinct-collection count per document.
// Collapsed into a single server fn (not getDocuments + a counts call)
// per the web-data-layer middleware-cost guidance.
export const getDocumentList = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .handler(async ({ context }): Promise<DocListItem[]> => {
    const store = storeOf(srv(context));
    const [docs, members, pendingCounts] = await Promise.all([
      store.listDocuments(),
      store.listResolvedMembers(),
      store.openSuggestionCounts(),
    ]);
    // Count the distinct collections each document resolves into —
    // including membership via a linked folder, not just direct edges.
    const contextsByDoc = new Map<string, Set<string>>();
    for (const m of members) {
      const set = contextsByDoc.get(m.documentSlug) ?? new Set<string>();
      set.add(m.collectionSlug);
      contextsByDoc.set(m.documentSlug, set);
    }
    return docs.map((d) => ({
      slug: asDocumentSlug(d.slug),
      title: d.title,
      docVersion: d.docVersion,
      size: d.size,
      collectionCount: contextsByDoc.get(d.slug)?.size ?? 0,
      pendingSuggestions: pendingCounts[d.slug] ?? 0,
      filename: d.filename,
      path: d.path,
      folderSlug: d.folderSlug === null ? null : asFolderSlug(d.folderSlug),
      updatedAt: d.updatedAt,
    }));
  });

export const getDocument = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<DocSnapshot | undefined> => {
    const d = await storeOf(srv(context)).getDocument(
      asDocumentSlug(data.slug),
    );
    return d === undefined
      ? undefined
      : {
          slug: asDocumentSlug(d.slug),
          title: d.title,
          filename: d.filename,
          markdown: d.markdown,
          docVersion: d.docVersion,
          updatedAt: d.updatedAt,
        };
  });

export const getDocumentHistory = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<DocVersionEntry[]> => {
    const c = srv(context);
    const entries = await storeOf(c).documentHistory(asDocumentSlug(data.slug));
    const names = await resolveUserNames(
      connectControlDb(c.env.DB),
      entries.map((e) => e.changedBy),
    );
    return entries.map((e) =>
      compact({ ...e, changedByName: names.get(e.changedBy) }),
    );
  });

export const saveDocument = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      slug: z.string().min(1),
      title: z.string().optional(),
      markdown: z.string(),
      // Basename incl. extension. Only meaningful on create (clientVersion:
      // 0) — an existing document keeps its filename via renameFilename.
      // Same basename rule as renameFilename: no path separator.
      filename: z
        .string()
        .trim()
        .min(1)
        .refine((v) => !v.includes("/"), "filename cannot contain a path")
        .optional(),
      clientVersion: z.number().int().nonnegative(),
    }),
  )
  .handler(async ({ data, context }): Promise<SaveResult> => {
    const fm = parseFrontmatter(data.markdown);
    if (!fm.ok) {
      throw new ValidationError(`invalid YAML frontmatter: ${fm.error}`);
    }
    const c = srv(context);
    await entitlementsOf(c).assertWithinQuota({
      action: data.clientVersion === 0 ? "document_create" : "version_create",
      userId: c.project?.userId,
      organizationId: c.project?.organizationId,
      projectId: c.project?.projectId,
      amount: 1,
      bytes: utf8Bytes(data.markdown),
    });
    const r = await storeOf(c).saveDocument(
      compact({
        slug: asDocumentSlug(data.slug),
        markdown: data.markdown,
        title: data.title,
        filename: data.filename,
        clientVersion: data.clientVersion,
        changedBy: changedBy(c),
      }),
    );
    if (r.ok) return { ok: true, docVersion: r.docVersion };
    if ("conflict" in r) {
      return { ok: false, conflict: true, currentVersion: r.currentVersion };
    }
    if ("segmentCollision" in r) {
      return { ok: false, segmentCollision: true };
    }
    return { ok: false, rolledBack: true };
  });

// Title-only rename. Separate from saveDocument: title is head metadata,
// not content — renaming must not cut a new version. No clientVersion
// gate (title is orthogonal to the content-addressed chain; an
// interleaved content save must not 409 a rename).
export const renameDocument = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      slug: z.string().min(1),
      title: z.string().trim().min(1),
    }),
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const c = srv(context);
    return storeOf(c).renameDocument({
      slug: asDocumentSlug(data.slug),
      title: data.title,
      changedBy: changedBy(c),
    });
  });

// First-class filename rename — distinct from renameDocument (title).
// A basename, not a path: `/` is rejected (moving between folders is
// placeDocumentInFolder's job). Surfaces a same-folder name clash so
// the UI can explain it.
export type FilenameResult = Readonly<
  { ok: true } | { ok: false; reason: "missing" | "segment-collision" }
>;

export const renameFilename = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      slug: z.string().min(1),
      filename: z
        .string()
        .trim()
        .min(1)
        .refine((v) => !v.includes("/"), "filename cannot contain a path"),
    }),
  )
  .handler(async ({ data, context }): Promise<FilenameResult> => {
    const c = srv(context);
    return storeOf(c).renameFilename({
      slug: asDocumentSlug(data.slug),
      filename: data.filename,
      changedBy: changedBy(c),
    });
  });

// ok:false = already gone/archived.
export const archiveDocument = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const c = srv(context);
    return storeOf(c).archiveDocument(asDocumentSlug(data.slug), changedBy(c));
  });

// Bulk soft-delete (the documents-list multi-select action). Atomic;
// returns how many of the selected slugs were actually archived.
export const archiveDocuments = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ slugs: z.array(z.string().min(1)).min(1) }))
  .handler(async ({ data, context }): Promise<{ archived: number }> => {
    const c = srv(context);
    return storeOf(c).archiveDocuments(
      data.slugs.map((s) => asDocumentSlug(s)),
      changedBy(c),
    );
  });
