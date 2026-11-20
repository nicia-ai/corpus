import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { connectControlDb } from "@/control/db";
import { revokeEmbassiesForDocuments } from "@/control/embassies";
import { entitlementsOf } from "@/control/entitlements";
import { ValidationError } from "@/errors";
import {
  asCorpusSlug,
  asDocumentSlug,
  asFolderSlug,
  type CorpusSlug,
  type DocumentSlug,
  type FolderSlug,
} from "@/ids";
import { projectMiddleware } from "@/lib/middleware";
import { changedBy, storeOf } from "@/lib/server/shared";
import {
  assertServerContext as srv,
  type ServerRequestContext,
} from "@/lib/server-context";
import { corpusIsServed } from "@/store/domain/corpus-drive";
import { parseFrontmatter } from "@/store/domain/frontmatter";
import {
  compact,
  MARKDOWN_TOO_LARGE_MESSAGE,
  markdownTooLarge,
  utf8Bytes,
} from "@/util";

// Plain, JSON-serializable shapes returned to loaders/components. Durable
// Object RPC returns carry non-serializable branding, so every handler
// maps to these explicitly (also gives loaders clean inferred types).
export type DocMeta = Readonly<{
  slug: DocumentSlug;
  title: string;
  docVersion: number;
  size: number;
}>;
// Documents list row: DocMeta plus the corpus the document lives in (every
// document lives in exactly one) and its corpus-relative path.
export type DocListItem = Readonly<{
  slug: DocumentSlug;
  title: string;
  docVersion: number;
  size: number;
  corpusSlug: CorpusSlug;
  // Open suggestions awaiting review (agent or human proposals) — the
  // documents-list badge.
  pendingSuggestions: number;
  filename: string;
  // Relative to the corpus root.
  path: string;
  // Stable slug of the document's folder; null = directly in the corpus root.
  folderSlug: FolderSlug | null;
  updatedAt: string;
}>;
export type RecentDocument = Readonly<{
  slug: DocumentSlug;
  title: string;
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
  | { ok: false; unknownLocation: true }
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
export type DocLinkRef = Readonly<{
  slug: string;
  path: string;
  corpusSlug: string;
}>;

export const getDocumentRefs = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .handler(async ({ context }): Promise<DocLinkRef[]> => {
    const refs = await storeOf(srv(context)).listDocumentRefs();
    return refs.map((r) => ({
      slug: r.slug,
      path: r.path,
      corpusSlug: r.corpusSlug,
    }));
  });

// Where a document lives: its corpus (named for people, not by slug) and
// whether agents can read it. Backs the document page's back link and the
// published / draft cue.
export type DocumentLocation = Readonly<{
  corpusSlug: CorpusSlug;
  corpusName: string;
  served: boolean;
}>;

export const getDocumentLocation = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .validator(z.object({ slug: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<DocumentLocation | undefined> => {
    const store = storeOf(srv(context));
    const [refs, corpora] = await Promise.all([
      store.listDocumentRefs(),
      store.listCorpora(),
    ]);
    const ref = refs.find((r) => r.slug === data.slug);
    const corpus = corpora.find((c) => c.slug === ref?.corpusSlug);
    if (ref === undefined || corpus === undefined) return undefined;
    const corpusSlug = asCorpusSlug(corpus.slug);
    return {
      corpusSlug,
      corpusName: corpus.name,
      served: corpusIsServed(corpusSlug),
    };
  });

// One round trip for the documents list: every live document with its
// corpus and corpus-relative path, plus the open-suggestion counts.
// Collapsed into a single server fn per the web-data-layer
// middleware-cost guidance.
export const getDocumentList = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .handler(async ({ context }): Promise<DocListItem[]> => {
    const store = storeOf(srv(context));
    const [docs, pendingCounts] = await Promise.all([
      store.listDocuments(),
      store.openSuggestionCounts(),
    ]);
    return docs.map((d) => ({
      slug: asDocumentSlug(d.slug),
      title: d.title,
      docVersion: d.docVersion,
      size: d.size,
      corpusSlug: asCorpusSlug(d.corpusSlug),
      pendingSuggestions: pendingCounts[d.slug] ?? 0,
      filename: d.filename,
      path: d.path,
      folderSlug: d.folderSlug === null ? null : asFolderSlug(d.folderSlug),
      updatedAt: d.updatedAt,
    }));
  });

export const getRecentDocuments = createServerFn({ method: "GET" })
  .middleware([projectMiddleware])
  .handler(async ({ context }): Promise<RecentDocument[]> => {
    const rows = await storeOf(srv(context)).recentDocuments();
    return rows.map((row) => ({
      slug: asDocumentSlug(row.slug),
      title: row.title,
      updatedAt: row.updatedAt,
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

export const saveDocument = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(
    z.object({
      slug: z.string().min(1),
      title: z.string().optional(),
      // Size rule lives in the handler, NOT here: a validator failure
      // serializes Zod issues into a raw Error the form surfaces verbatim,
      // while the handler throws a clean ValidationError.
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
      // Where a NEW document is created, atomically with the save: a corpus
      // and optionally a folder of it. Absent = the default corpus (drafts).
      // Only meaningful on create.
      location: z
        .object({
          corpusSlug: z.string().min(1),
          folderSlug: z.string().min(1).nullish(),
        })
        .optional(),
      clientVersion: z.number().int().nonnegative(),
    }),
  )
  .handler(async ({ data, context }): Promise<SaveResult> => {
    // Exact early refusal (UTF-8 bytes, unlike the length-only Zod gate)
    // with the friendly message; the DO byte check remains the authority.
    if (markdownTooLarge(data.markdown)) {
      throw new ValidationError(MARKDOWN_TOO_LARGE_MESSAGE);
    }
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
        location:
          data.location === undefined
            ? undefined
            : {
                corpusSlug: asCorpusSlug(data.location.corpusSlug),
                folderSlug:
                  data.location.folderSlug == null
                    ? null
                    : asFolderSlug(data.location.folderSlug),
              },
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
    if ("unknownLocation" in r) return { ok: false, unknownLocation: true };
    // The DO's authoritative UTF-8 byte cap — same boundary treatment as
    // the frontmatter check above (validation kind → HTTP 400).
    if ("tooLarge" in r) throw new ValidationError(MARKDOWN_TOO_LARGE_MESSAGE);
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
// moveDocument's job). Surfaces a same-folder name clash so
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
    const slug = asDocumentSlug(data.slug);
    const result = await storeOf(c).archiveDocument(slug, changedBy(c));
    await revokeShareLinks(c, [slug]);
    return result;
  });

// Bulk soft-delete (the documents-list multi-select action). Atomic;
// returns how many of the selected slugs were actually archived.
export const archiveDocuments = createServerFn({ method: "POST" })
  .middleware([projectMiddleware])
  .validator(z.object({ slugs: z.array(z.string().min(1)).min(1) }))
  .handler(async ({ data, context }): Promise<{ archived: number }> => {
    const c = srv(context);
    const slugs = data.slugs.map((s) => asDocumentSlug(s));
    const result = await storeOf(c).archiveDocuments(slugs, changedBy(c));
    await revokeShareLinks(c, slugs);
    return result;
  });

async function revokeShareLinks(
  c: ServerRequestContext,
  slugs: readonly DocumentSlug[],
): Promise<void> {
  const projectId = c.project?.projectId;
  if (projectId === undefined) return;
  await revokeEmbassiesForDocuments(connectControlDb(c.env.DB), {
    projectId,
    documentSlugs: slugs,
  });
}
