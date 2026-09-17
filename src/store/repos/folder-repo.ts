import type { Node } from "@nicia-ai/typegraph";

import type { Folder } from "../../graph";
import {
  asCorpusSlug,
  asDocumentSlug,
  type CorpusSlug,
  type DocumentSlug,
  type FolderSlug,
} from "../../ids";
import type { FolderTreeNode } from "../domain/collection-expand";
import {
  appendPosition,
  type SiblingSegment,
  segmentCollides,
  wouldCreateCycle,
} from "../domain/folders";
import type { GraphHandle } from "../handle";

import type { DocumentNode } from "./document-repo";

export type FolderNode = Node<typeof Folder>;

const FOLDER_WALK_MAX_HOPS = 100;

export type DocumentPathRow = Readonly<{
  slug: string;
  filename: string;
  folderSlug: string | null;
  ancestorNames: readonly string[];
}>;

export type FolderView = Readonly<{
  slug: string;
  name: string;
  parentSlug: string | null;
  position: number;
}>;

export type CreateFolderResult = Readonly<
  { ok: true; node: FolderNode } | { ok: false; reason: "segment-collision" }
>;

// `changed: false` = a successful no-op (rename-to-same, move/place to
// the current parent): nothing was written, so the path-map fan-out
// must be suppressed (it would spam every folder-linking corpus).
export type RenameFolderResult = Readonly<
  | { ok: true; changed: boolean }
  | { ok: false; reason: "missing" | "segment-collision" }
>;

export type MoveFolderResult = Readonly<
  | { ok: true; changed: boolean }
  | { ok: false; reason: "missing" | "cycle" | "segment-collision" }
>;

export type DeleteFolderResult = Readonly<
  | {
      ok: true;
      // Documents that were in the deleted subtree — the DO archives
      // each (folder delete is a cascade, never a re-home).
      documentSlugs: readonly DocumentSlug[];
      // Corpora whose `includes_folder` edge to this folder was
      // released — the DO must re-snapshot them so their latest
      // CorpusVersion (and the bundle) no longer lists the gone tree.
      unlinkedCollections: readonly CorpusSlug[];
    }
  | { ok: false; reason: "missing" }
>;

export type PlaceDocumentResult = Readonly<
  | { ok: true; changed: boolean }
  | { ok: false; reason: "missing" | "segment-collision" }
>;

// All Folder node + `folder_child`/`in_folder` edge access. The folder
// tree's single-parent invariant and the cross-type, root-aware
// `(parent, segment)` sibling namespace are enforced HERE inside the
// DO's write() tx — race-free because the DO serializes per-Project and
// the tx is atomic. Pure tree rules live in domain/folders.ts; this
// loads and applies them. `null` parent = project root throughout.
//
// Helpers take nodes (not ids) and return inferred edges so TypeGraph's
// branded NodeId/EdgeId flow through unbroken (mirrors the other repos).
export class FolderRepo {
  constructor(private readonly g: GraphHandle) {}

  // — Lookups ————————————————————————————————————————————————

  private async nodeBySlug(slug: string): Promise<FolderNode | undefined> {
    const [node] = await this.g.nodes.Folder.find({
      where: (f) => f.slug.eq(slug),
      limit: 1,
    });
    return node;
  }

  find(slug: FolderSlug): Promise<FolderNode | undefined> {
    return this.nodeBySlug(slug);
  }

  private async docBySlug(
    slug: DocumentSlug,
  ): Promise<DocumentNode | undefined> {
    const [doc] = await this.g.nodes.Document.find({
      where: (d) => d.slug.eq(slug),
      limit: 1,
    });
    return doc;
  }

  // The inbound parent edge of a folder (single-parent → 0 or 1).
  private async parentEdge(folder: FolderNode) {
    const [edge] = await this.g.edges.folder_child.findTo({
      kind: "Folder",
      id: folder.id,
    });
    return edge;
  }

  private async docFolderEdge(doc: DocumentNode) {
    const [edge] = await this.g.edges.in_folder.findFrom({
      kind: "Document",
      id: doc.id,
    });
    return edge;
  }

  // The same inbound parent edge, but for a SET of folders in one read:
  // `bulkFindTo` widens `to_id = ?` into `to_id IN (...)`, so a caller
  // that already holds every folder pays a statement per bind-budget
  // chunk instead of one per folder. Keyed by folder id; single-parent
  // means at most one edge each, so an absent key IS "at the root".
  private async parentEdgesOf(folders: readonly FolderNode[]) {
    const grouped = await this.g.edges.folder_child.bulkFindTo(
      folders.map((f) => ({ kind: "Folder" as const, id: f.id })),
      { limitPerInput: 1 },
    );
    return new Map(
      folders.flatMap((f, i) => {
        const edge = grouped[i]?.[0];
        return edge === undefined ? [] : [[f.id, edge] as const];
      }),
    );
  }

  private async parentSlugOf(node: FolderNode): Promise<string | null> {
    const edge = await this.parentEdge(node);
    if (edge === undefined) return null;
    const parent = await this.g.nodes.Folder.getById(edge.fromId);
    return parent?.slug ?? null;
  }

  // — Edge writers (single-parent: caller deletes the old edge first) —

  private async linkChildFolder(
    parentSlug: string,
    child: FolderNode,
  ): Promise<void> {
    const parent = await this.nodeBySlug(parentSlug);
    if (parent === undefined) return;
    const positions = (await this.childFolders(parentSlug)).map(
      (c) => c.position,
    );
    await this.g.edges.folder_child.create(
      { kind: "Folder", id: parent.id },
      { kind: "Folder", id: child.id },
      { position: appendPosition(positions) },
    );
  }

  private async linkDocument(
    folderSlug: string,
    doc: DocumentNode,
  ): Promise<void> {
    const folder = await this.nodeBySlug(folderSlug);
    if (folder === undefined) return;
    const count = (await this.documentsIn(folderSlug)).length;
    await this.g.edges.in_folder.create(
      { kind: "Document", id: doc.id },
      { kind: "Folder", id: folder.id },
      { position: count + 1 },
    );
  }

  // — Children / siblings ————————————————————————————————————

  private async childFolders(
    parentSlug: string | null,
  ): Promise<readonly Readonly<{ node: FolderNode; position: number }>[]> {
    if (parentSlug === null) {
      const rows = await this.g
        .query()
        .from("Folder", "f")
        .optionalTraverse("folder_child", "e", { direction: "in" })
        .to("Folder", "parent")
        .select((ctx) => ({ node: ctx.f, orphan: ctx.parent === undefined }))
        .execute();
      return rows
        .filter((row) => row.orphan)
        .map((row) => ({ node: row.node, position: 0 }));
    }
    return this.g
      .query()
      .from("Folder", "f")
      .whereNode("f", (f) => f.slug.eq(parentSlug))
      .traverse("folder_child", "e")
      .to("Folder", "child")
      .select((ctx) => ({ node: ctx.child, position: ctx.e.position }))
      .execute();
  }

  private async documentsIn(
    parentSlug: string | null,
  ): Promise<readonly DocumentNode[]> {
    if (parentSlug === null) {
      const rows = await this.g
        .query()
        .from("Document", "d")
        .optionalTraverse("in_folder", "e")
        .to("Folder", "folder")
        .select((ctx) => ({ doc: ctx.d, orphan: ctx.folder === undefined }))
        .execute();
      return rows.filter((row) => row.orphan).map((row) => row.doc);
    }
    return this.g
      .query()
      .from("Folder", "f")
      .whereNode("f", (f) => f.slug.eq(parentSlug))
      .traverse("in_folder", "e", { direction: "in" })
      .to("Document", "d")
      .select((ctx) => ctx.d)
      .execute();
  }

  // The cross-type sibling namespace shape (the folder/document
  // collision invariant) — built identically wherever it's checked.
  private toSiblingSegments(
    folders: readonly Readonly<{ node: FolderNode }>[],
    docs: readonly DocumentNode[],
  ): SiblingSegment[] {
    return [
      ...folders.map((f) => ({
        kind: "folder" as const,
        slug: f.node.slug,
        segment: f.node.name,
      })),
      ...docs.map((d) => ({
        kind: "document" as const,
        slug: d.slug,
        segment: d.filename,
      })),
    ];
  }

  // The cross-type sibling namespace under a parent: child folders
  // contribute `name`, documents contribute `filename`. Archived docs
  // are excluded — once archived, a doc no longer occupies its filename
  // slot for collision checks (so a re-upload at the same path lands on
  // a fresh document, and the slot is free for a new sibling).
  private async siblingSegments(
    parentSlug: string | null,
  ): Promise<SiblingSegment[]> {
    const [folders, docs] = await Promise.all([
      this.childFolders(parentSlug),
      this.documentsIn(parentSlug),
    ]);
    return this.toSiblingSegments(
      folders,
      docs.filter((d) => d.archivedAt === undefined),
    );
  }

  // child slug → parent slug | null, for cycle detection on move.
  private async parentMap(): Promise<Map<string, string | null>> {
    return new Map(
      (await this.listAll()).map((folder) => [folder.slug, folder.parentSlug]),
    );
  }

  // — Derived reads ——————————————————————————————————————————

  // A folder and its ancestors, leaf → root, cycle-guarded. The single
  // upward walk; `ancestorNames` is a projection of it (the only caller
  // outside this class).
  private async ancestorChain(node: FolderNode): Promise<FolderNode[]> {
    const rows = await this.g
      .query()
      .from("Folder", "f")
      .whereNode("f", (f) => f.id.eq(node.id))
      .traverse("folder_child", "e", { direction: "in" })
      .recursive({ minHops: 1, maxHops: FOLDER_WALK_MAX_HOPS, depth: "depth" })
      .to("Folder", "ancestor")
      .select((ctx) => ({ ancestor: ctx.ancestor, depth: ctx.depth }))
      .execute();
    return [
      node,
      ...[...rows].sort((a, b) => a.depth - b.depth).map((row) => row.ancestor),
    ];
  }

  // Ancestor folder names, root → leaf (for path derivation).
  async ancestorNames(node: FolderNode): Promise<string[]> {
    const chain = await this.ancestorChain(node);
    return chain.reverse().map((n) => n.name);
  }

  // The folder a document is in (its single home), or null at root.
  async documentFolder(documentSlug: DocumentSlug): Promise<FolderNode | null> {
    const doc = await this.docBySlug(documentSlug);
    if (doc === undefined) return null;
    const edge = await this.docFolderEdge(doc);
    if (edge === undefined) return null;
    return (await this.g.nodes.Folder.getById(edge.toId)) ?? null;
  }

  // The doc's folder + every ancestor folder, as slugs (leaf → root).
  // Empty when the doc is at the root or doesn't exist. Used by
  // `archiveDocument` to fan a folder-tree-changed snapshot out to every
  // corpus whose `includes_folder` link surfaces this doc via folder
  // expansion (a link to either the doc's folder OR any ancestor).
  async documentFolderAncestorSlugs(
    documentSlug: DocumentSlug,
  ): Promise<readonly string[]> {
    const folder = await this.documentFolder(documentSlug);
    if (folder === null) return [];
    return (await this.ancestorChain(folder)).map((n) => n.slug);
  }

  async liveDocumentPaths(): Promise<readonly DocumentPathRow[]> {
    const rows = await this.g
      .query()
      .from("Document", "d")
      .whereNode("d", (d) => d.archivedAt.isNull())
      .optionalTraverse("in_folder", "home")
      .to("Folder", "folder")
      .optionalTraverse("folder_child", "up", {
        direction: "in",
        from: "folder",
      })
      .recursive({ minHops: 0, maxHops: FOLDER_WALK_MAX_HOPS, depth: "depth" })
      .to("Folder", "ancestor")
      .select((ctx) => ({
        slug: ctx.d.slug,
        filename: ctx.d.filename,
        folderSlug: ctx.folder?.slug,
        ancestorName: ctx.ancestor?.name,
        depth: ctx.depth,
      }))
      .execute();
    const bySlug = new Map<
      string,
      {
        filename: string;
        folderSlug: string | null;
        ancestors: { name: string; depth: number }[];
      }
    >();
    for (const row of rows) {
      let entry = bySlug.get(row.slug);
      if (entry === undefined) {
        entry = {
          filename: row.filename,
          folderSlug: row.folderSlug ?? null,
          ancestors: [],
        };
        bySlug.set(row.slug, entry);
      }
      if (row.ancestorName !== undefined && row.depth !== undefined) {
        entry.ancestors.push({ name: row.ancestorName, depth: row.depth });
      }
    }
    return [...bySlug.entries()].map(([slug, entry]) => ({
      slug,
      filename: entry.filename,
      folderSlug: entry.folderSlug,
      ancestorNames: [...entry.ancestors]
        .sort((a, b) => b.depth - a.depth)
        .map((ancestor) => ancestor.name),
    }));
  }

  // Whether `filename` is free for `documentSlug` under its CURRENT
  // home folder — the same cross-type (folder|document) segment rule
  // `placeDocument` enforces, but for a filename rename (the document
  // does not move; only its segment changes). Excludes the document
  // itself so renaming to its own filename is not a self-collision.
  async filenameAvailable(
    documentSlug: DocumentSlug,
    filename: string,
  ): Promise<boolean> {
    const doc = await this.docBySlug(documentSlug);
    if (doc === undefined) return false;
    const edge = await this.docFolderEdge(doc);
    const parentSlug =
      edge === undefined
        ? null
        : ((await this.g.nodes.Folder.getById(edge.toId))?.slug ?? null);
    const siblings = await this.siblingSegments(parentSlug);
    return !segmentCollides(siblings, filename, {
      kind: "document",
      slug: documentSlug,
    });
  }

  // The subtree rooted at `rootSlug` as plain data for the pure
  // resolver (zero-IO there). Recursive expansion is cycle-prevented.
  async subtree(rootSlug: string): Promise<Map<string, FolderTreeNode>> {
    const map = new Map<string, FolderTreeNode>();
    const rows = await this.g
      .query()
      .from("Folder", "root")
      .whereNode("root", (root) => root.slug.eq(rootSlug))
      .optionalTraverse("folder_child", "e")
      .recursive({ minHops: 0, maxHops: FOLDER_WALK_MAX_HOPS })
      .to("Folder", "folder")
      .select((ctx) => ctx.folder)
      .execute();
    const folders = [
      ...new Map(
        rows.flatMap((folder) =>
          folder === undefined ? [] : [[folder.id, folder] as const],
        ),
      ).values(),
    ];
    if (folders.length === 0) {
      map.set(rootSlug, { slug: rootSlug, childFolders: [], documents: [] });
      return map;
    }
    const folderRefs = folders.map((folder) => ({
      kind: "Folder" as const,
      id: folder.id,
    }));
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const [childGroups, documentGroups] = await Promise.all([
      this.g.edges.folder_child.bulkFindFrom(folderRefs),
      this.g.edges.in_folder.bulkFindTo(folderRefs),
    ]);
    const documentEdges = documentGroups.flat();
    const documents = await this.g.nodes.Document.getByIds(
      documentEdges.map((edge) => edge.fromId),
    );
    const documentsByFolder = new Map<
      string,
      { slug: string; filename: string }[]
    >();
    for (const [i, edge] of documentEdges.entries()) {
      const document = documents[i];
      const folder = byId.get(edge.toId);
      if (document === undefined || folder === undefined) continue;
      const list = documentsByFolder.get(folder.slug) ?? [];
      list.push({ slug: document.slug, filename: document.filename });
      documentsByFolder.set(folder.slug, list);
    }
    for (const [i, folder] of folders.entries()) {
      map.set(folder.slug, {
        slug: folder.slug,
        childFolders: (childGroups[i] ?? []).flatMap((edge) => {
          const child = byId.get(edge.toId);
          return child === undefined
            ? []
            : [{ slug: child.slug, position: edge.position }];
        }),
        documents: documentsByFolder.get(folder.slug) ?? [],
      });
    }
    return map;
  }

  // The document occupying `filename` directly under `folderSlug`
  // (null = root), or undefined. This is how bulk upload is idempotent
  // on path: a re-upload resolves to the SAME document (→ a new
  // version), never a duplicate. Archived docs are excluded — they no
  // longer occupy the slot, so a re-upload at the same path creates a
  // fresh document rather than silently writing a new version onto a
  // hidden (archived) head.
  // Resolve an EXISTING folder chain by directory names (root → leaf),
  // creating nothing: the leaf folder's slug, null for an empty chain
  // (project root), or undefined when any segment is missing — the path
  // cannot be occupied by a document if its folder doesn't exist yet.
  async folderAt(
    dirSegments: readonly string[],
  ): Promise<string | null | undefined> {
    let parentSlug: string | null = null;
    for (const name of dirSegments) {
      const children = await this.childFolders(parentSlug);
      const match = children.find((c) => c.node.name === name);
      if (match === undefined) return undefined;
      parentSlug = match.node.slug;
    }
    return parentSlug;
  }

  // Would a NEW document named `filename` collide with any existing
  // sibling segment — document OR folder — in the folder? The same
  // cross-type namespace rule placeDocument enforces on placement,
  // exposed as a read so a proposal can fail before any write. No
  // `self` exclusion: the document does not exist yet.
  async slotOccupied(
    folderSlug: string | null,
    filename: string,
  ): Promise<boolean> {
    const siblings = await this.siblingSegments(folderSlug);
    return segmentCollides(siblings, filename);
  }

  async documentAt(
    folderSlug: string | null,
    filename: string,
  ): Promise<DocumentNode | undefined> {
    const docs = await this.documentsIn(folderSlug);
    return docs.find(
      (d) => d.filename === filename && d.archivedAt === undefined,
    );
  }

  // Resolve an ancestor folder chain by NAME (the original directory
  // basenames), creating only the missing suffix, and return the leaf
  // folder slug (null = no dir segments → project root). Existing
  // folders are reused by name so a re-upload is idempotent. Plan first
  // (find the deepest existing prefix + detect a folder/document
  // segment collision) and only then create — so the failure path
  // makes no writes; the success path's creates are still inside the
  // caller's single write() tx.
  async ensureFolderPath(
    dirSegments: readonly string[],
    now: string,
    makeFolderSlug: (name: string, taken: ReadonlySet<string>) => FolderSlug,
  ): Promise<
    Readonly<
      | { ok: true; folderSlug: string | null; created: readonly string[] }
      | { ok: false; reason: "segment-collision" }
    >
  > {
    if (dirSegments.length === 0) {
      return { ok: true, folderSlug: null, created: [] };
    }

    // Walk the deepest existing prefix (match child folders by name).
    let parentSlug: string | null = null;
    let i = 0;
    for (; i < dirSegments.length; i += 1) {
      const seg = dirSegments[i];
      if (seg === undefined) break;
      const children = await this.childFolders(parentSlug);
      const hit = children.find((c) => c.node.name === seg);
      if (hit === undefined) break;
      parentSlug = hit.node.slug;
    }
    const remaining = dirSegments.slice(i);
    if (remaining.length === 0) {
      return { ok: true, folderSlug: parentSlug, created: [] };
    }

    // The first to-create segment must not collide with an existing
    // document under the deepest existing folder (deeper segments are
    // created under brand-new empty folders → no collisions possible).
    const firstSeg = remaining[0];
    if (
      firstSeg !== undefined &&
      (await this.documentAt(parentSlug, firstSeg)) !== undefined
    ) {
      return { ok: false, reason: "segment-collision" };
    }

    const taken = new Set(
      (
        await this.g
          .query()
          .from("Folder", "f")
          .project((e) => ({ slug: e.f.slug }))
          .execute()
      ).map((row) => row.slug),
    );
    const created: string[] = [];
    for (const seg of remaining) {
      const slug = makeFolderSlug(seg, taken);
      taken.add(slug);
      const outcome = await this.create({
        slug,
        name: seg,
        createdAt: now,
        parentSlug,
      });
      if (!outcome.ok) return { ok: false, reason: outcome.reason };
      parentSlug = outcome.node.slug;
      created.push(outcome.node.slug);
    }
    return { ok: true, folderSlug: parentSlug, created };
  }

  // Whole tree as flat views (parent + position), for UI render and
  // bundle export. Caller builds the nesting.
  async listAll(): Promise<readonly FolderView[]> {
    const rows = await this.g
      .query()
      .from("Folder", "f")
      .optionalTraverse("folder_child", "e", { direction: "in" })
      .to("Folder", "parent")
      .select((ctx) => ({
        slug: ctx.f.slug,
        name: ctx.f.name,
        parentSlug: ctx.parent?.slug ?? null,
        position: ctx.e?.position ?? 0,
      }))
      .execute();
    return rows;
  }

  // — Mutations (single-parent + sibling namespace enforced) ————

  async create(
    args: Readonly<{
      slug: FolderSlug;
      name: string;
      createdAt: string;
      parentSlug: string | null;
    }>,
  ): Promise<CreateFolderResult> {
    const siblings = await this.siblingSegments(args.parentSlug);
    if (segmentCollides(siblings, args.name)) {
      return { ok: false, reason: "segment-collision" };
    }
    const node = await this.g.nodes.Folder.create({
      slug: args.slug,
      name: args.name,
      createdAt: args.createdAt,
    });
    if (args.parentSlug !== null) {
      await this.linkChildFolder(args.parentSlug, node);
    }
    return { ok: true, node };
  }

  // Verbatim folder reconstruction for bundle import: the node + its
  // parent edge with the EXACT serialized `position` (not
  // `appendPosition`, so folders[].position round-trips byte-identical).
  // No collision/cycle check — the data is post-rootHash-verified and
  // lands in a fresh project, mirroring importBundle's direct-write
  // path (`u.docs.put`, `u.cols.attach`). Callers create parents before
  // children. `createdAt` is not in the bundle (not a contract field).
  async importFolder(
    args: Readonly<{
      slug: FolderSlug;
      name: string;
      createdAt: string;
      parentSlug: string | null;
      position: number;
    }>,
  ): Promise<void> {
    const node = await this.g.nodes.Folder.create({
      slug: args.slug,
      name: args.name,
      createdAt: args.createdAt,
    });
    if (args.parentSlug === null) return;
    const parent = await this.nodeBySlug(args.parentSlug);
    if (parent === undefined) return;
    await this.g.edges.folder_child.create(
      { kind: "Folder", id: parent.id },
      { kind: "Folder", id: node.id },
      { position: args.position },
    );
  }

  async rename(slug: FolderSlug, name: string): Promise<RenameFolderResult> {
    const node = await this.find(slug);
    if (node === undefined) return { ok: false, reason: "missing" };
    if (node.name === name) return { ok: true, changed: false };
    const siblings = await this.siblingSegments(await this.parentSlugOf(node));
    if (segmentCollides(siblings, name, { kind: "folder", slug })) {
      return { ok: false, reason: "segment-collision" };
    }
    await this.g.nodes.Folder.update(node.id, { name });
    return { ok: true, changed: true };
  }

  async move(
    slug: FolderSlug,
    newParentSlug: string | null,
  ): Promise<MoveFolderResult> {
    const node = await this.find(slug);
    if (node === undefined) return { ok: false, reason: "missing" };
    if (
      newParentSlug !== null &&
      (await this.nodeBySlug(newParentSlug)) === undefined
    ) {
      return { ok: false, reason: "missing" };
    }
    if ((await this.parentSlugOf(node)) === newParentSlug) {
      return { ok: true, changed: false };
    }
    if (wouldCreateCycle(slug, newParentSlug, await this.parentMap())) {
      return { ok: false, reason: "cycle" };
    }
    const siblings = await this.siblingSegments(newParentSlug);
    if (segmentCollides(siblings, node.name, { kind: "folder", slug })) {
      return { ok: false, reason: "segment-collision" };
    }
    const existing = await this.parentEdge(node);
    if (existing !== undefined) {
      await this.g.edges.folder_child.hardDelete(existing.id);
    }
    if (newParentSlug !== null) {
      await this.linkChildFolder(newParentSlug, node);
    }
    return { ok: true, changed: true };
  }

  // Cascade delete: the folder and its whole subtree are removed.
  // Descendant folders are hard-deleted (they carry no version history);
  // documents are detached and returned for the DO to archive (the
  // soft-delete documents get everywhere). No re-home, so no name-clash
  // can ever block a delete.
  async delete(slug: FolderSlug): Promise<DeleteFolderResult> {
    const node = await this.find(slug);
    if (node === undefined) return { ok: false, reason: "missing" };
    const documentSlugs: DocumentSlug[] = [];
    const unlinked = new Set<CorpusSlug>();
    // Deepest-first: a folder node is hard-deleted only after its children
    // are gone, so it is never still connected by a `folder_child` edge.
    // Read every relationship before mutating. The loop only consumes each
    // folder's cached parent edge, so an earlier delete cannot invalidate it.
    const subtree = await this.subtreeFolders(node);
    const folderRefs = subtree.map((folder) => ({
      kind: "Folder" as const,
      id: folder.id,
    }));
    const [parents, documentEdgeGroups, corpusEdgeGroups] = await Promise.all([
      this.parentEdgesOf(subtree),
      this.g.edges.in_folder.bulkFindTo(folderRefs),
      this.g.edges.includes_folder.bulkFindTo(folderRefs),
    ]);
    const documentEdges = documentEdgeGroups.flat();
    const documents = await this.g.nodes.Document.getByIds(
      documentEdges.map((edge) => edge.fromId),
    );
    for (const [i, edge] of documentEdges.entries()) {
      const document = documents[i];
      await this.g.edges.in_folder.hardDelete(edge.id);
      if (document !== undefined) {
        documentSlugs.push(asDocumentSlug(document.slug));
      }
    }
    const corpusEdges = corpusEdgeGroups.flat();
    const corpora = await this.g.nodes.Collection.getByIds([
      ...new Set(corpusEdges.map((edge) => edge.fromId)),
    ]);
    for (const corpus of corpora) {
      if (corpus !== undefined) {
        unlinked.add(asCorpusSlug(corpus.slug));
      }
    }
    for (const edge of corpusEdges) {
      await this.g.edges.includes_folder.hardDelete(edge.id);
    }
    for (const f of subtree) {
      const own = parents.get(f.id);
      if (own !== undefined) await this.g.edges.folder_child.hardDelete(own.id);
      await this.g.nodes.Folder.hardDelete(f.id);
    }
    return { ok: true, documentSlugs, unlinkedCollections: [...unlinked] };
  }

  // The folder plus every descendant folder, deepest-first: a parent is
  // never removed while a child edge still binds it.
  private async subtreeFolders(root: FolderNode): Promise<FolderNode[]> {
    const rows = await this.g
      .query()
      .from("Folder", "root")
      .whereNode("root", (folder) => folder.id.eq(root.id))
      .optionalTraverse("folder_child", "e")
      .recursive({ minHops: 0, maxHops: FOLDER_WALK_MAX_HOPS, depth: "depth" })
      .to("Folder", "folder")
      .select((ctx) => ({ folder: ctx.folder, depth: ctx.depth }))
      .execute();
    const unique = new Map<string, { folder: FolderNode; depth: number }>();
    for (const row of rows) {
      if (row.folder === undefined) continue;
      unique.set(row.folder.id, {
        folder: row.folder,
        depth: row.depth ?? 0,
      });
    }
    if (!unique.has(root.id)) unique.set(root.id, { folder: root, depth: 0 });
    return [...unique.values()]
      .sort((a, b) => b.depth - a.depth)
      .map((row) => row.folder);
  }

  // Place (or re-place) a document in a folder (null = root). Replaces
  // the single `in_folder` edge; enforces the sibling namespace by the
  // document's `filename`.
  async placeDocument(
    documentSlug: DocumentSlug,
    folderSlug: string | null,
  ): Promise<PlaceDocumentResult> {
    const doc = await this.docBySlug(documentSlug);
    if (doc === undefined) return { ok: false, reason: "missing" };
    if (
      folderSlug !== null &&
      (await this.nodeBySlug(folderSlug)) === undefined
    ) {
      return { ok: false, reason: "missing" };
    }
    // A true no-op only when an edge ALREADY points at the requested
    // folder (re-place to the identical folder). A doc with no edge is
    // "at root" but UNVALIDATED — placing it (even to root) must still
    // run the sibling-namespace check, so it is never a no-op here.
    const existing = await this.docFolderEdge(doc);
    if (existing !== undefined && folderSlug !== null) {
      const current = await this.g.nodes.Folder.getById(existing.toId);
      if (current?.slug === folderSlug) return { ok: true, changed: false };
    }
    const siblings = await this.siblingSegments(folderSlug);
    if (
      segmentCollides(siblings, doc.filename, {
        kind: "document",
        slug: documentSlug,
      })
    ) {
      return { ok: false, reason: "segment-collision" };
    }
    if (existing !== undefined) {
      await this.g.edges.in_folder.hardDelete(existing.id);
    }
    if (folderSlug !== null) {
      await this.linkDocument(folderSlug, doc);
    }
    return { ok: true, changed: true };
  }
}
