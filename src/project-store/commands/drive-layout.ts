import { InternalError } from "../../errors";
import {
  asCorpusSlug,
  asDocumentSlug,
  asFolderSlug,
  type CorpusSlug,
  type FolderSlug,
} from "../../ids";
import {
  documentMovedOut,
  MEMBERSHIP_REASON_LAYOUT,
} from "../../store/domain/change-events";
import {
  byCreation,
  corpusRootFolderSlug,
  type LayoutDocument,
  type LayoutPlacement,
  planDriveLayout,
} from "../../store/domain/corpus-drive";
import { DEFAULT_CORPUS_SLUG } from "../../store/domain/default-corpus";
import { normalizeSlug } from "../../store/domain/paths";
import type { FolderView } from "../../store/repos/folder-repo";
import type {
  CommandOutcome,
  DomainChange,
  ProjectCommandContext,
} from "../command";

import { ensureCorpusRoot } from "./corpus-tree";
import { ensureDefaultCorpusCommand } from "./ensure-default-corpus";

// Recorded as the author of everything the layout pass writes.
export const DRIVE_LAYOUT_ACTOR = "system:corpus-drive-layout";

export type DriveLayoutResult = Readonly<{
  // False when the project already was laid out as drives: nothing was
  // written, so running the pass again is always safe.
  changed: boolean;
  placed: number;
  conflicts: number;
  // True when this call finished the layout (roots linked, legacy links
  // dropped, leftovers removed, snapshots cut). False = a bounded batch of
  // placements was committed and the caller must call again.
  complete: boolean;
}>;

// corpus slug → the documents it resolved in the old shape.
export type LayoutMembership = ReadonlyMap<string, readonly string[]>;

const UNCHANGED: DriveLayoutResult = {
  changed: false,
  placed: 0,
  conflicts: 0,
  complete: true,
};

// What the old shape says about membership: direct `includes` edges plus
// every document under a folder a corpus linked.
async function storedMembership(
  ctx: ProjectCommandContext,
): Promise<
  (
    doc: Readonly<{ slug: string; ancestorSlugs: readonly string[] }>,
  ) => string[]
> {
  const [documentLinks, folderLinks] = await Promise.all([
    ctx.u.cols.legacyDocumentLinks(),
    ctx.u.cols.folderLinks(),
  ]);
  const direct = new Map<string, string[]>();
  for (const link of documentLinks) {
    direct.set(link.documentSlug, [
      ...(direct.get(link.documentSlug) ?? []),
      link.corpusSlug,
    ]);
  }
  const linkedFolders = folderLinks.filter(
    (link) => link.folderSlug !== corpusRootFolderSlug(link.corpusSlug),
  );
  return (doc) => [
    ...(direct.get(doc.slug) ?? []),
    ...linkedFolders
      .filter((link) => doc.ancestorSlugs.includes(link.folderSlug))
      .map((link) => link.corpusSlug as string),
  ];
}

function givenMembership(
  membership: LayoutMembership,
): (doc: Readonly<{ slug: string }>) => string[] {
  const byDocument = new Map<string, string[]>();
  for (const [corpusSlug, documentSlugs] of membership) {
    for (const slug of documentSlugs) {
      byDocument.set(slug, [...(byDocument.get(slug) ?? []), corpusSlug]);
    }
  }
  return (doc) => byDocument.get(doc.slug) ?? [];
}

// The folder tree as it was before the layout: every folder that does not
// hang under a corpus root, with the chain of names that leads to it.
type LegacyFolder = Readonly<{
  slug: string;
  depth: number;
  position: number;
  names: readonly string[];
  parentSlug: string | null;
}>;

function legacyFolders(
  folders: readonly FolderView[],
  roots: ReadonlySet<string>,
): readonly LegacyFolder[] {
  const bySlug = new Map(folders.map((f) => [f.slug, f]));
  const chainOf = (slug: string): readonly FolderView[] => {
    const chain: FolderView[] = [];
    const seen = new Set<string>();
    for (
      let cursor = bySlug.get(slug);
      cursor !== undefined && !seen.has(cursor.slug);
      cursor =
        cursor.parentSlug === null ? undefined : bySlug.get(cursor.parentSlug)
    ) {
      seen.add(cursor.slug);
      chain.unshift(cursor);
    }
    return chain;
  };
  return folders.flatMap((f) => {
    const chain = chainOf(f.slug);
    const top = chain[0];
    return top === undefined || roots.has(top.slug)
      ? []
      : [
          {
            slug: f.slug,
            depth: chain.length,
            position: f.position,
            names: chain.map((c) => c.name),
            parentSlug: f.parentSlug,
          },
        ];
  });
}

// Carry EVERY old folder across, in its old sibling order, under the root of
// the corpus its documents went to: a folder of a corpus's documents is
// recreated there; a folder with no documents in its subtree (an empty one
// the user made) follows the nearest ancestor that has some, else lands in
// drafts. Folders are created parents-first and, among siblings, in their
// old `position`, so the new tree reads in the order the old one did. Runs
// once, in the first batch, while every document is still where it was.
async function carryFoldersAcross(
  ctx: ProjectCommandContext,
  args: Readonly<{
    legacy: readonly LegacyFolder[];
    placements: readonly LayoutPlacement[];
    ancestorsOf: ReadonlyMap<string, readonly string[]>;
    rootOf: ReadonlyMap<string, FolderSlug>;
    rank: (corpusSlug: string) => number;
  }>,
): Promise<void> {
  const own = new Map<string, Set<string>>();
  for (const placement of args.placements) {
    for (const ancestor of args.ancestorsOf.get(placement.documentSlug) ?? []) {
      const set = own.get(ancestor) ?? new Set<string>();
      set.add(placement.corpusSlug);
      own.set(ancestor, set);
    }
  }
  const bySlug = new Map(args.legacy.map((f) => [f.slug, f]));
  const targetsOf = (folder: LegacyFolder): readonly string[] => {
    for (
      let cursor: LegacyFolder | undefined = folder;
      cursor !== undefined;
      cursor =
        cursor.parentSlug === null ? undefined : bySlug.get(cursor.parentSlug)
    ) {
      const targets = own.get(cursor.slug);
      if (targets !== undefined) {
        return [...targets].sort((a, b) => args.rank(a) - args.rank(b));
      }
    }
    return [DEFAULT_CORPUS_SLUG];
  };
  const ordered = [...args.legacy].sort(
    (a, b) =>
      a.depth - b.depth ||
      a.position - b.position ||
      (a.names.join("/") < b.names.join("/") ? -1 : 1),
  );
  for (const folder of ordered) {
    // An empty folder follows its nearest populated ancestor to ONE corpus
    // (the earliest-created); a populated one is needed in each corpus that
    // took documents from it.
    const targets = own.has(folder.slug)
      ? targetsOf(folder)
      : targetsOf(folder).slice(0, 1);
    for (const corpusSlug of targets) {
      const root = args.rootOf.get(corpusSlug);
      if (root === undefined) {
        throw new InternalError(
          `drive layout: corpus ${corpusSlug} has no root`,
        );
      }
      const ensured = await ctx.u.folders.ensureFolderPath(
        root,
        folder.names,
        ctx.now,
        (name, taken) => asFolderSlug(normalizeSlug(name, taken)),
      );
      if (!ensured.ok) {
        throw new InternalError(
          `drive layout: cannot recreate ${folder.names.join("/")} (${ensured.reason})`,
        );
      }
    }
  }
}

// Lay a project out as drives, in the caller's transaction. Every corpus
// gets its root folder; every document outside a root moves under the root
// of the corpus that owns it (`planDriveLayout` is the rule), keeping its
// project path as its corpus-relative path; every old folder (empty ones too,
// in their old order) is carried across; the old links and the emptied
// top-level folders are removed. Documents are re-homed by moving one edge
// each — history, comments, proposals and share links are keyed by slug and
// are not touched. Idempotent: on an already-laid-out project it reads,
// finds nothing to do, and writes nothing.
//
// DEVIATION from "one transaction": a project can hold more documents than
// one transaction should move, and a transaction that fails rolls back
// everything, so a big project would retry the whole pass on every call
// forever. `placementLimit` bounds the placements one call commits; the
// caller loops until `complete`. The state between calls is safe because a
// placed document is simply "already under a root" (the next call skips it
// and recomputes the rest from the graph), the legacy links stay until the
// last call so membership can still be derived, and the caller does not
// serve any read or write until the loop has finished. The folder carry-over
// runs in the first call (while nobody is placed yet); the link drop,
// leftover removal and snapshots run in the last.
//
// `membership` overrides what the graph says (bundle import supplies the
// bundle's member lists; there are no legacy edges to read there).
// `snapshot` cuts a fresh CorpusVersion per corpus at the end; bundle
// import keeps the bundle's own snapshots instead.
export async function layOutAsDrivesCommand(
  ctx: ProjectCommandContext,
  options: Readonly<{
    membership?: LayoutMembership;
    snapshot: boolean;
    placementLimit?: number;
  }>,
): Promise<CommandOutcome<DriveLayoutResult>> {
  const [corpora, paths, memberOf, folderViews] = await Promise.all([
    ctx.u.cols.listByCreation(),
    ctx.u.folders.allDocumentPaths(),
    options.membership === undefined
      ? storedMembership(ctx)
      : Promise.resolve(givenMembership(options.membership)),
    ctx.u.folders.listAll(),
  ]);
  const corpusOfRoot = new Map(
    corpora.map((c) => [corpusRootFolderSlug(c.slug) as string, c.slug]),
  );
  const documents: LayoutDocument[] = paths
    // An archived document whose folder was deleted lives nowhere, and
    // stays there: it is not drafts.
    .filter(({ path, archived }) => !(archived && path.folderSlug === null))
    .map(({ path }) => {
      const topSlug = path.ancestorSlugs[0];
      return {
        slug: path.slug,
        folderNames: path.ancestorNames,
        homeCorpusSlug:
          topSlug === undefined ? undefined : corpusOfRoot.get(topSlug),
        memberOf: memberOf(path),
      };
    });
  const plan = planDriveLayout({
    corpora,
    defaultCorpusSlug: DEFAULT_CORPUS_SLUG,
    documents,
  });
  const limit = options.placementLimit ?? Number.POSITIVE_INFINITY;
  const batch = plan.placements.slice(0, limit);
  const complete = plan.placements.length <= limit;
  const firstBatch = documents.every((d) => d.homeCorpusSlug === undefined);
  const legacy = firstBatch
    ? legacyFolders(folderViews, new Set(corpusOfRoot.keys()))
    : [];

  const changes: DomainChange[] = [];
  const usesDefault =
    batch.some((p) => p.corpusSlug === DEFAULT_CORPUS_SLUG) ||
    legacy.length > 0;
  if (usesDefault) {
    const ensured = await ensureDefaultCorpusCommand(ctx, DRIVE_LAYOUT_ACTOR);
    changes.push(...ensured.changes);
  }
  let rootsLinked = 0;
  const rootOf = new Map<string, FolderSlug>();
  for (const corpusSlug of new Set<CorpusSlug>([
    ...corpora.map((c) => c.slug),
    ...batch.map((p) => asCorpusSlug(p.corpusSlug)),
    ...(usesDefault ? [DEFAULT_CORPUS_SLUG] : []),
  ])) {
    if ((await ctx.u.cols.rootFolderSlug(corpusSlug)) === undefined) {
      rootsLinked += 1;
    }
    const root = await ensureCorpusRoot(ctx, corpusSlug);
    if (root !== undefined) rootOf.set(corpusSlug, root);
  }

  if (legacy.length > 0) {
    const creationRank = new Map(
      [...corpora].sort(byCreation).map((c, i) => [c.slug as string, i]),
    );
    await carryFoldersAcross(ctx, {
      legacy,
      placements: plan.placements,
      ancestorsOf: new Map(
        paths.map(({ path }) => [path.slug, path.ancestorSlugs]),
      ),
      rootOf,
      rank: (slug) =>
        slug === DEFAULT_CORPUS_SLUG
          ? Number.MAX_SAFE_INTEGER
          : (creationRank.get(slug) ?? Number.MAX_SAFE_INTEGER),
    });
  }

  // Placements grouped by destination folder, so each folder's documents
  // move together with set reads instead of one read pass per document.
  const folderCache = new Map<string, FolderSlug>();
  const byFolder = new Map<FolderSlug, string[]>();
  for (const placement of batch) {
    const root = rootOf.get(placement.corpusSlug);
    if (root === undefined) {
      throw new InternalError(
        `drive layout: corpus ${placement.corpusSlug} has no root`,
      );
    }
    const cacheKey = JSON.stringify([
      placement.corpusSlug,
      ...placement.folderNames,
    ]);
    let folderSlug = folderCache.get(cacheKey);
    if (folderSlug === undefined) {
      const ensured = await ctx.u.folders.ensureFolderPath(
        root,
        placement.folderNames,
        ctx.now,
        (name, taken) => asFolderSlug(normalizeSlug(name, taken)),
      );
      if (!ensured.ok) {
        throw new InternalError(
          `drive layout: cannot recreate ${cacheKey} (${ensured.reason})`,
        );
      }
      folderSlug = ensured.folderSlug;
      folderCache.set(cacheKey, folderSlug);
    }
    byFolder.set(folderSlug, [
      ...(byFolder.get(folderSlug) ?? []),
      placement.documentSlug,
    ]);
  }
  for (const [folderSlug, slugs] of byFolder) {
    await ctx.u.folders.rehomeDocuments(
      folderSlug,
      await ctx.u.docs.findMany(slugs.map(asDocumentSlug)),
    );
  }

  const placedSlugs = new Set(batch.map((p) => p.documentSlug));
  const conflicts = plan.conflicts.filter((c) =>
    placedSlugs.has(c.documentSlug),
  );
  for (const conflict of conflicts) {
    for (const droppedFrom of conflict.droppedFrom) {
      changes.push(
        documentMovedOut({
          corpusSlug: asCorpusSlug(droppedFrom),
          documentSlug: asDocumentSlug(conflict.documentSlug),
          toCorpusSlug: asCorpusSlug(conflict.keptIn),
          reason: MEMBERSHIP_REASON_LAYOUT,
          changedBy: DRIVE_LAYOUT_ACTOR,
          changedAt: ctx.now,
        }),
      );
    }
  }
  const progress = { placed: batch.length, conflicts: conflicts.length };
  if (!complete) {
    return { result: { changed: true, ...progress, complete }, changes };
  }

  const linksDropped = await ctx.u.cols.dropLegacyLinks();
  const roots = new Set<string>(rootOf.values());
  const leftovers = (await ctx.u.folders.listAll()).filter(
    (folder) => folder.parentSlug === null && !roots.has(folder.slug),
  );
  for (const folder of leftovers) {
    await ctx.u.folders.delete(asFolderSlug(folder.slug));
  }
  if (
    batch.length === 0 &&
    rootsLinked === 0 &&
    linksDropped === 0 &&
    leftovers.length === 0
  ) {
    return { result: UNCHANGED, changes: [] };
  }
  if (options.snapshot) {
    for (const corpusSlug of rootOf.keys()) {
      await ctx.corpus.snapshot(
        ctx.u,
        asCorpusSlug(corpusSlug),
        DRIVE_LAYOUT_ACTOR,
        ctx.now,
      );
    }
  }
  return { result: { changed: true, ...progress, complete }, changes };
}
