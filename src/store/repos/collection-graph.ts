import type { Node } from "@nicia-ai/typegraph";

import type { Collection, CollectionFields } from "../../graph";
import type { CollectionSlug, DocumentSlug, FolderSlug } from "../../ids";
import { type Compact, compact } from "../../util";
import {
  collectionDelivery,
  DEFAULT_COLLECTION_DELIVERY,
  type CollectionDelivery,
} from "../domain/collection-expand";
import type { GraphHandle } from "../handle";

import type { DocumentNode } from "./document-repo";
import { findAll } from "./paginate";

export type CollectionNode = Node<typeof Collection>;

// Raw collection membership edges (no hydration): the input the shared
// resolver merges by the unified position space.
export type CollectionEntries = Readonly<{
  documents: readonly Readonly<{
    slug: string;
    position: number;
    delivery: CollectionDelivery;
  }>[];
  folders: readonly Readonly<{
    slug: string;
    position: number;
    delivery: CollectionDelivery;
  }>[];
}>;

// The collection head-node fields the repo returns from `list`. Derived
// from the user-defined `Collection` Zod schema (`src/graph.ts`) so a
// new editable field added to the node schema flows through here without
// a duplicated declaration. `Compact<>` converts Zod's `T | undefined`
// optionals into true `T?` optionals so the shape composes under
// `exactOptionalPropertyTypes` without forcing every caller's destination
// type to widen.
export type CollectionMeta = Readonly<Compact<CollectionFields>>;

// A collection member as resolved from the graph: the document head
// pinned by content hash + version, in attach order. The DO hydrates
// `markdown` from the blob store (corpus) or snapshots this directly
// (CollectionVersion).
export type CollectionDocView = Readonly<{
  slug: string;
  title: string;
  docVersion: number;
  contentHash: string;
  updatedAt: string;
  position: number;
  delivery: CollectionDelivery;
}>;

// What happened to the includes edge — the DO turns this into the change
// event so the attached-vs-reordered rule lives in one place. `unchanged`
// means the call was a true no-op (an existing edge already at the
// requested `position` + `delivery`): the DO skips snapshot + event
// emission so a double-click / retry / scripted reconciliation can't
// grow the audit log or cut a byte-equal CollectionVersion.
export type AttachResult = Readonly<
  | { ok: false }
  | { ok: true; change: "attached" }
  | { ok: true; change: "reordered"; previousPosition: number }
  | { ok: true; change: "unchanged" }
>;

// Collection nodes + the `includes` edge (the dedup/organizer graph:
// one doc, many collections). Owns all graph traversal so the DO never
// touches edges directly.
export class CollectionGraph {
  constructor(private readonly g: GraphHandle) {}

  async findCollection(
    slug: CollectionSlug,
  ): Promise<CollectionNode | undefined> {
    const [col] = await this.g.nodes.Collection.find({
      where: (a) => a.slug.eq(slug),
      limit: 1,
    });
    return col;
  }

  private async findDoc(slug: DocumentSlug): Promise<DocumentNode | undefined> {
    const [doc] = await this.g.nodes.Document.find({
      where: (d) => d.slug.eq(slug),
      limit: 1,
    });
    return doc;
  }

  async createCollection(
    fields: Readonly<{
      slug: CollectionSlug;
      name: string;
      description: string | undefined;
      alwaysIncludeBudgetTokens: number;
    }>,
  ): Promise<void> {
    await this.g.nodes.Collection.create(
      compact({
        slug: fields.slug,
        name: fields.name,
        description: fields.description,
        alwaysIncludeBudgetTokens: fields.alwaysIncludeBudgetTokens,
      }),
    );
  }

  // Edit a collection's name/description. Slug is identity (pinned in every
  // CollectionVersion, the bundle sort key) so it is never touched, and
  // membership is unchanged so no CollectionVersion is cut — this is a
  // head-node-only partial-merge update. `description: ""` is a present
  // value that overwrites (empty = "no description" for display).
  // Returns undefined when the collection does not exist.
  async updateCollection(
    slug: CollectionSlug,
    fields: Readonly<{
      name: string;
      description: string;
      alwaysIncludeBudgetTokens: number;
    }>,
  ): Promise<CollectionNode | undefined> {
    const col = await this.findCollection(slug);
    if (col === undefined) return undefined;
    return this.g.nodes.Collection.update(col.id, {
      name: fields.name,
      description: fields.description,
      alwaysIncludeBudgetTokens: fields.alwaysIncludeBudgetTokens,
    });
  }

  async list(limit: number): Promise<readonly CollectionMeta[]> {
    return this.toMetas(await this.g.nodes.Collection.find({ limit }));
  }

  // Every collection, paginated (bundle export); `list(limit)` is the bounded
  // UI variant.
  async listAll(): Promise<readonly CollectionMeta[]> {
    return this.toMetas(await findAll((w) => this.g.nodes.Collection.find(w)));
  }

  private toMetas(cols: readonly CollectionNode[]): readonly CollectionMeta[] {
    return cols.map((c) =>
      compact({
        slug: c.slug,
        name: c.name,
        description: c.description,
        alwaysIncludeBudgetTokens: c.alwaysIncludeBudgetTokens,
      }),
    );
  }

  // Attach a new edge or re-position an existing one; the return tells
  // the caller which happened (and the prior position, for the event).
  // An idempotent re-attach (same position + delivery as the existing
  // edge) returns `unchanged` so the DO can skip the snapshot + event:
  // a double-click, retried POST, or scripted reconciliation must not
  // grow the audit log or cut a byte-equal CollectionVersion.
  async attach(
    collectionSlug: CollectionSlug,
    documentSlug: DocumentSlug,
    position: number,
    delivery: CollectionDelivery = DEFAULT_COLLECTION_DELIVERY,
  ): Promise<AttachResult> {
    const [col, doc] = await Promise.all([
      this.findCollection(collectionSlug),
      this.findDoc(documentSlug),
    ]);
    if (
      col === undefined ||
      doc === undefined ||
      doc.archivedAt !== undefined
    ) {
      return { ok: false };
    }
    const edges = await this.g.edges.includes.findFrom({
      kind: "Collection",
      id: col.id,
    });
    const current = edges.find((e) => e.toId === doc.id);
    if (current === undefined) {
      await this.g.edges.includes.create(
        { kind: "Collection", id: col.id },
        { kind: "Document", id: doc.id },
        { position, delivery },
      );
      return { ok: true, change: "attached" };
    }
    const previousPosition = current.position;
    if (
      previousPosition === position &&
      collectionDelivery(current.delivery) === delivery
    ) {
      return { ok: true, change: "unchanged" };
    }
    await this.g.edges.includes.update(current.id, { position, delivery });
    return { ok: true, change: "reordered", previousPosition };
  }

  // Append many documents in one pass: a single collection + edge read,
  // then one edge create per document not already linked (archived or
  // missing documents are skipped, mirroring `attach`'s rules). Amortizes
  // the per-call reads `attach` repeats, so a bulk upload link is O(N)
  // not O(N·members). Positions continue after the current max across the
  // shared document+folder space, computed by reduce (no arg-spread cap).
  // Returns the slugs actually added with their positions, in input
  // order, for the caller's change events.
  async attachMany(
    collectionSlug: CollectionSlug,
    documentSlugs: readonly DocumentSlug[],
    delivery: CollectionDelivery,
  ): Promise<readonly Readonly<{ slug: DocumentSlug; position: number }>[]> {
    const col = await this.findCollection(collectionSlug);
    if (col === undefined) return [];
    const [docEdges, folderEdges] = await Promise.all([
      this.g.edges.includes.findFrom({ kind: "Collection", id: col.id }),
      this.g.edges.includes_folder.findFrom({ kind: "Collection", id: col.id }),
    ]);
    const presentDocIds = new Set(docEdges.map((e) => e.toId));
    let position = [...docEdges, ...folderEdges].reduce(
      (max, e) => Math.max(max, e.position),
      -1,
    );
    const attached: { slug: DocumentSlug; position: number }[] = [];
    for (const slug of documentSlugs) {
      const doc = await this.findDoc(slug);
      if (doc === undefined || doc.archivedAt !== undefined) continue;
      if (presentDocIds.has(doc.id)) continue;
      position += 1;
      await this.g.edges.includes.create(
        { kind: "Collection", id: col.id },
        { kind: "Document", id: doc.id },
        { position, delivery },
      );
      presentDocIds.add(doc.id);
      attached.push({ slug, position });
    }
    return attached;
  }

  // Flip a document member's delivery tier WITHOUT touching its position.
  // The edge update merges props, so `position` is preserved (same
  // guarantee `setOrder` relies on) — this is why the caller must NOT
  // route a tier change through `attach`, whose position argument would
  // overwrite the stored edge position. `undefined` = no such edge;
  // `{ changed: false }` = already that tier (a no-op the DO turns into
  // "nothing happened," so a double-click can't double-snapshot).
  async setDelivery(
    collectionSlug: CollectionSlug,
    documentSlug: DocumentSlug,
    delivery: CollectionDelivery,
  ): Promise<{ changed: boolean } | undefined> {
    const [col, doc] = await Promise.all([
      this.findCollection(collectionSlug),
      this.findDoc(documentSlug),
    ]);
    if (col === undefined || doc === undefined) return undefined;
    const edges = await this.g.edges.includes.findFrom({
      kind: "Collection",
      id: col.id,
    });
    const current = edges.find((e) => e.toId === doc.id);
    if (current === undefined) return undefined;
    if (collectionDelivery(current.delivery) === delivery)
      return { changed: false };
    await this.g.edges.includes.update(current.id, { delivery });
    return { changed: true };
  }

  // Remove the includes edge for (collection, document). Returns the
  // position it held (for the change event), or undefined when there was
  // no such edge — a no-op the DO turns into "nothing happened".
  async detach(
    collectionSlug: CollectionSlug,
    documentSlug: DocumentSlug,
  ): Promise<number | undefined> {
    const [col, doc] = await Promise.all([
      this.findCollection(collectionSlug),
      this.findDoc(documentSlug),
    ]);
    if (col === undefined || doc === undefined) return undefined;
    const edges = await this.g.edges.includes.findFrom({
      kind: "Collection",
      id: col.id,
    });
    const edge = edges.find((e) => e.toId === doc.id);
    if (edge === undefined) return undefined;
    await this.g.edges.includes.hardDelete(edge.id);
    return edge.position;
  }

  // Rewrite direct-document edge positions following `orderedDocumentSlugs`.
  // Folder links share the same position space, so reordering direct docs
  // must reuse the current direct-document slots instead of normalizing to
  // 1..n; otherwise a folder-linked collection can have its folder anchors
  // crossed by a direct-only drag from the UI. Slugs not currently attached
  // are skipped. false only when the collection itself is missing.
  async setOrder(
    collectionSlug: CollectionSlug,
    orderedDocumentSlugs: readonly DocumentSlug[],
  ): Promise<boolean> {
    const col = await this.findCollection(collectionSlug);
    if (col === undefined) return false;
    const edges = await this.g.edges.includes.findFrom({
      kind: "Collection",
      id: col.id,
    });
    const edgeBySlug = new Map<
      string,
      Readonly<{ id: (typeof edges)[number]["id"]; position: number }>
    >();
    await Promise.all(
      edges.map(async (e) => {
        const d = await this.g.nodes.Document.getById(e.toId);
        if (d !== undefined) edgeBySlug.set(d.slug, e);
      }),
    );
    const orderedEdges = orderedDocumentSlugs.flatMap((slug) => {
      const edge = edgeBySlug.get(slug);
      return edge === undefined ? [] : [edge];
    });
    if (orderedEdges.length === 0) return false;
    const positions = orderedEdges
      .map((edge) => edge.position)
      .sort((a, b) => a - b);
    // No edge actually moves when the supplied order already matches the
    // current position order — skip the writes + signal no-op so the DO
    // can elide the snapshot + reorder event (same churn-elimination
    // contract as `attach`'s `unchanged` branch).
    let changed = false;
    for (let i = 0; i < orderedEdges.length; i += 1) {
      const edge = orderedEdges[i];
      const position = positions[i];
      if (edge !== undefined && position !== undefined) {
        if (edge.position !== position) {
          await this.g.edges.includes.update(edge.id, { position });
          changed = true;
        }
      }
    }
    return changed;
  }

  // Position-ordered document heads of a collection (each pinned by
  // contentHash + docVersion), or undefined if the collection does not
  // exist. The DO hydrates bytes / builds the snapshot from this.
  async ordered(
    collectionSlug: CollectionSlug,
  ): Promise<readonly CollectionDocView[] | undefined> {
    const col = await this.findCollection(collectionSlug);
    if (col === undefined) return undefined;
    const edges = await this.g.edges.includes.findFrom({
      kind: "Collection",
      id: col.id,
    });
    const docs = await Promise.all(
      edges.map(async (e) => {
        const d = await this.g.nodes.Document.getById(e.toId);
        return d === undefined
          ? undefined
          : {
              d,
              position: e.position,
              delivery: collectionDelivery(e.delivery),
            };
      }),
    );
    return docs
      .filter((x) => x !== undefined)
      .sort(
        (a, b) => a.position - b.position || a.d.slug.localeCompare(b.d.slug),
      )
      .map((x) => ({
        slug: x.d.slug,
        title: x.d.title,
        docVersion: x.d.docVersion,
        contentHash: x.d.contentHash,
        updatedAt: x.d.updatedAt,
        position: x.position,
        delivery: x.delivery,
      }));
  }

  // Collections whose assembled corpus changes when this document changes.
  async collectionsIncluding(
    documentSlug: DocumentSlug,
  ): Promise<readonly string[]> {
    const doc = await this.findDoc(documentSlug);
    if (doc === undefined) return [];
    const edges = await this.g.edges.includes.findTo({
      kind: "Document",
      id: doc.id,
    });
    const cols = await Promise.all(
      edges.map((ed) => this.g.nodes.Collection.getById(ed.fromId)),
    );
    return cols.flatMap((c) => (c === undefined ? [] : [c.slug]));
  }

  // — Folder→collection links ————————————————————————————————————

  private async findFolder(slug: string) {
    const [f] = await this.g.nodes.Folder.find({
      where: (n) => n.slug.eq(slug),
      limit: 1,
    });
    return f;
  }

  // Raw direct-document + folder-include edges (slug + position), the
  // shared resolver's input. undefined when the collection is missing.
  async entries(
    collectionSlug: CollectionSlug,
  ): Promise<CollectionEntries | undefined> {
    const col = await this.findCollection(collectionSlug);
    if (col === undefined) return undefined;
    const [docEdges, folderEdges] = await Promise.all([
      this.g.edges.includes.findFrom({ kind: "Collection", id: col.id }),
      this.g.edges.includes_folder.findFrom({
        kind: "Collection",
        id: col.id,
      }),
    ]);
    const documents = (
      await Promise.all(
        docEdges.map(async (e) => {
          const d = await this.g.nodes.Document.getById(e.toId);
          return d === undefined
            ? undefined
            : {
                slug: d.slug,
                position: e.position,
                delivery: collectionDelivery(e.delivery),
              };
        }),
      )
    ).filter((x) => x !== undefined);
    const folders = (
      await Promise.all(
        folderEdges.map(async (e) => {
          const f = await this.g.nodes.Folder.getById(e.toId);
          return f === undefined
            ? undefined
            : {
                slug: f.slug,
                position: e.position,
                delivery: collectionDelivery(e.delivery),
              };
        }),
      )
    ).filter((x) => x !== undefined);
    return { documents, folders };
  }

  // Attach a new folder→collection link or re-position an existing one
  // (mirrors `attach` for documents; shares the position space). An
  // idempotent re-attach returns `unchanged` for the same reason
  // documented on `attach` above.
  async attachFolder(
    collectionSlug: CollectionSlug,
    folderSlug: FolderSlug,
    position: number,
    delivery: CollectionDelivery = DEFAULT_COLLECTION_DELIVERY,
  ): Promise<AttachResult> {
    const [col, folder] = await Promise.all([
      this.findCollection(collectionSlug),
      this.findFolder(folderSlug),
    ]);
    if (col === undefined || folder === undefined) return { ok: false };
    const edges = await this.g.edges.includes_folder.findFrom({
      kind: "Collection",
      id: col.id,
    });
    const current = edges.find((e) => e.toId === folder.id);
    if (current === undefined) {
      await this.g.edges.includes_folder.create(
        { kind: "Collection", id: col.id },
        { kind: "Folder", id: folder.id },
        { position, delivery },
      );
      return { ok: true, change: "attached" };
    }
    const previousPosition = current.position;
    if (
      previousPosition === position &&
      collectionDelivery(current.delivery) === delivery
    ) {
      return { ok: true, change: "unchanged" };
    }
    await this.g.edges.includes_folder.update(current.id, {
      position,
      delivery,
    });
    return { ok: true, change: "reordered", previousPosition };
  }

  // Position-preserving delivery-tier flip for a folder link (mirrors
  // `setDelivery` for documents). Same merge guarantee keeps `position`.
  async setFolderDelivery(
    collectionSlug: CollectionSlug,
    folderSlug: FolderSlug,
    delivery: CollectionDelivery,
  ): Promise<{ changed: boolean } | undefined> {
    const [col, folder] = await Promise.all([
      this.findCollection(collectionSlug),
      this.findFolder(folderSlug),
    ]);
    if (col === undefined || folder === undefined) return undefined;
    const edges = await this.g.edges.includes_folder.findFrom({
      kind: "Collection",
      id: col.id,
    });
    const current = edges.find((e) => e.toId === folder.id);
    if (current === undefined) return undefined;
    if (collectionDelivery(current.delivery) === delivery)
      return { changed: false };
    await this.g.edges.includes_folder.update(current.id, { delivery });
    return { changed: true };
  }

  async detachFolder(
    collectionSlug: CollectionSlug,
    folderSlug: FolderSlug,
  ): Promise<number | undefined> {
    const [col, folder] = await Promise.all([
      this.findCollection(collectionSlug),
      this.findFolder(folderSlug),
    ]);
    if (col === undefined || folder === undefined) return undefined;
    const edges = await this.g.edges.includes_folder.findFrom({
      kind: "Collection",
      id: col.id,
    });
    const edge = edges.find((e) => e.toId === folder.id);
    if (edge === undefined) return undefined;
    await this.g.edges.includes_folder.hardDelete(edge.id);
    return edge.position;
  }

  // Reverse fan-out: collections that link ANY of these folders directly
  // (the DO passes a document's folder + its ancestors).
  async collectionsIncludingFolders(
    folderSlugs: readonly string[],
  ): Promise<readonly string[]> {
    const out = new Set<string>();
    for (const slug of folderSlugs) {
      const folder = await this.findFolder(slug);
      if (folder === undefined) continue;
      const edges = await this.g.edges.includes_folder.findTo({
        kind: "Folder",
        id: folder.id,
      });
      for (const e of edges) {
        const c = await this.g.nodes.Collection.getById(e.fromId);
        if (c !== undefined) out.add(c.slug);
      }
    }
    return [...out];
  }

  // Every collection with at least one folder link — the coarse v1
  // path-map-mutation fan-out set (a folder rename/move can only change
  // the expansion of a collection that links some folder).
  async collectionsWithFolderLinks(): Promise<readonly string[]> {
    const cols = await findAll((w) => this.g.nodes.Collection.find(w));
    const out: string[] = [];
    for (const c of cols) {
      const edges = await this.g.edges.includes_folder.findFrom({
        kind: "Collection",
        id: c.id,
      });
      if (edges.length > 0) out.push(c.slug);
    }
    return out;
  }
}
