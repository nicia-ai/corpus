import type { Node } from "@nicia-ai/typegraph";

import {
  type Collection,
  type CollectionFields,
  DOCUMENT_SLUG_INDEX,
  FOLDER_SLUG_INDEX,
} from "../../graph";
import type { CorpusSlug, DocumentSlug, FolderSlug } from "../../ids";
import { type Compact, compact } from "../../util";
import {
  corpusDelivery,
  DEFAULT_COLLECTION_DELIVERY,
  type CollectionDelivery,
} from "../domain/collection-expand";
import type { GraphHandle } from "../handle";

import type { DocumentNode } from "./document-repo";
import { findAll } from "./paginate";

export type CorpusNode = Node<typeof Collection>;

// Raw corpus membership edges (no hydration): the input the shared
// resolver merges by the unified position space.
export type CorpusEntries = Readonly<{
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

// The corpus head-node fields the repo returns from `list`. Derived
// from the user-defined `Corpus` Zod schema (`src/graph.ts`) so a
// new editable field added to the node schema flows through here without
// a duplicated declaration. `Compact<>` converts Zod's `T | undefined`
// optionals into true `T?` optionals so the shape composes under
// `exactOptionalPropertyTypes` without forcing every caller's destination
// type to widen.
export type CorpusMeta = Readonly<Compact<CollectionFields>>;

// A corpus member as resolved from the graph: the document head
// pinned by content hash + version, in attach order. The DO hydrates
// `markdown` from the blob store (corpus) or snapshots this directly
// (CorpusVersion).
export type CorpusDocView = Readonly<{
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
// grow the audit log or cut a byte-equal CorpusVersion.
export type AttachResult = Readonly<
  | { ok: false }
  | { ok: true; change: "attached" }
  | { ok: true; change: "reordered"; previousPosition: number }
  | { ok: true; change: "unchanged" }
>;

// Corpus nodes + the `includes` edge (the dedup/organizer graph:
// one doc, many corpora). Owns all graph traversal so the DO never
// touches edges directly.
export class CorpusGraph {
  constructor(private readonly g: GraphHandle) {}

  async findCorpus(slug: CorpusSlug): Promise<CorpusNode | undefined> {
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

  async createCorpus(
    fields: Readonly<{
      slug: CorpusSlug;
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

  // Edit a corpus's name/description. Slug is identity (pinned in every
  // CorpusVersion, the bundle sort key) so it is never touched, and
  // membership is unchanged so no CorpusVersion is cut — this is a
  // head-node-only partial-merge update. `description: ""` is a present
  // value that overwrites (empty = "no description" for display).
  // Returns undefined when the corpus does not exist.
  async updateCorpus(
    slug: CorpusSlug,
    fields: Readonly<{
      name: string;
      description: string;
      alwaysIncludeBudgetTokens: number;
    }>,
  ): Promise<CorpusNode | undefined> {
    const col = await this.findCorpus(slug);
    if (col === undefined) return undefined;
    return this.g.nodes.Collection.update(col.id, {
      name: fields.name,
      description: fields.description,
      alwaysIncludeBudgetTokens: fields.alwaysIncludeBudgetTokens,
    });
  }

  async list(limit: number): Promise<readonly CorpusMeta[]> {
    return this.toMetas(await this.g.nodes.Collection.find({ limit }));
  }

  // Every corpus, paginated (bundle export); `list(limit)` is the bounded
  // UI variant.
  async listAll(): Promise<readonly CorpusMeta[]> {
    return this.toMetas(await findAll((w) => this.g.nodes.Collection.find(w)));
  }

  private toMetas(cols: readonly CorpusNode[]): readonly CorpusMeta[] {
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
  // grow the audit log or cut a byte-equal CorpusVersion.
  async attach(
    corpusSlug: CorpusSlug,
    documentSlug: DocumentSlug,
    position: number,
    delivery: CollectionDelivery = DEFAULT_COLLECTION_DELIVERY,
  ): Promise<AttachResult> {
    const [col, doc] = await Promise.all([
      this.findCorpus(corpusSlug),
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
      corpusDelivery(current.delivery) === delivery
    ) {
      return { ok: true, change: "unchanged" };
    }
    await this.g.edges.includes.update(current.id, { position, delivery });
    return { ok: true, change: "reordered", previousPosition };
  }

  // Append many documents in one pass: a single corpus + edge read,
  // then one edge create per document not already linked (archived or
  // missing documents are skipped, mirroring `attach`'s rules). Amortizes
  // the per-call reads `attach` repeats, so a bulk upload link is O(N)
  // not O(N·members). Positions continue after the current max across the
  // shared document+folder space, computed by reduce (no arg-spread cap).
  // Returns the slugs actually added with their positions, in input
  // order, for the caller's change events.
  async attachMany(
    corpusSlug: CorpusSlug,
    documentSlugs: readonly DocumentSlug[],
    delivery: CollectionDelivery,
  ): Promise<readonly Readonly<{ slug: DocumentSlug; position: number }>[]> {
    const col = await this.findCorpus(corpusSlug);
    if (col === undefined) return [];
    const [documentEdges, folderEdges] = await Promise.all([
      this.g.edges.includes.findFrom({ kind: "Collection", id: col.id }),
      this.g.edges.includes_folder.findFrom({ kind: "Collection", id: col.id }),
    ]);
    const presentDocIds = new Set(documentEdges.map((e) => e.toId));
    let position = [...documentEdges, ...folderEdges].reduce(
      (max, e) => Math.max(max, e.position),
      -1,
    );
    const docs = await this.g.nodes.Document.bulkFindByIndex(
      DOCUMENT_SLUG_INDEX,
      documentSlugs.map((slug) => ({ props: { slug } })),
      { limitPerInput: 1 },
    );
    const attached: { slug: DocumentSlug; position: number }[] = [];
    for (const [i, slug] of documentSlugs.entries()) {
      const doc = docs[i]?.[0];
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
    corpusSlug: CorpusSlug,
    documentSlug: DocumentSlug,
    delivery: CollectionDelivery,
  ): Promise<{ changed: boolean } | undefined> {
    const [col, doc] = await Promise.all([
      this.findCorpus(corpusSlug),
      this.findDoc(documentSlug),
    ]);
    if (col === undefined || doc === undefined) return undefined;
    const edges = await this.g.edges.includes.findFrom({
      kind: "Collection",
      id: col.id,
    });
    const current = edges.find((e) => e.toId === doc.id);
    if (current === undefined) return undefined;
    if (corpusDelivery(current.delivery) === delivery)
      return { changed: false };
    await this.g.edges.includes.update(current.id, { delivery });
    return { changed: true };
  }

  // Remove the includes edge for (corpus, document). Returns the
  // position it held (for the change event), or undefined when there was
  // no such edge — a no-op the DO turns into "nothing happened".
  async detach(
    corpusSlug: CorpusSlug,
    documentSlug: DocumentSlug,
  ): Promise<number | undefined> {
    const [col, doc] = await Promise.all([
      this.findCorpus(corpusSlug),
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
  // 1..n; otherwise a folder-linked corpus can have its folder anchors
  // crossed by a direct-only drag from the UI. Slugs not currently attached
  // are skipped. false only when the corpus itself is missing.
  async setOrder(
    corpusSlug: CorpusSlug,
    orderedDocumentSlugs: readonly DocumentSlug[],
  ): Promise<boolean> {
    const col = await this.findCorpus(corpusSlug);
    if (col === undefined) return false;
    const edges = await this.g.edges.includes.findFrom({
      kind: "Collection",
      id: col.id,
    });
    const edgeBySlug = new Map<
      string,
      Readonly<{ id: (typeof edges)[number]["id"]; position: number }>
    >();
    const docs = await this.g.nodes.Document.getByIds(
      edges.map((edge) => edge.toId),
    );
    for (const [i, edge] of edges.entries()) {
      const doc = docs[i];
      if (doc !== undefined) edgeBySlug.set(doc.slug, edge);
    }
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

  // Position-ordered document heads of a corpus (each pinned by
  // contentHash + docVersion), or undefined if the corpus does not
  // exist. The DO hydrates bytes / builds the snapshot from this.
  async ordered(
    corpusSlug: CorpusSlug,
  ): Promise<readonly CorpusDocView[] | undefined> {
    const col = await this.findCorpus(corpusSlug);
    if (col === undefined) return undefined;
    const edges = await this.g.edges.includes.findFrom({
      kind: "Collection",
      id: col.id,
    });
    // Hydrated in one chunked read (see `entries`), not a `getById` per
    // member — this feeds every corpus assembly and CorpusVersion.
    const heads = await this.g.nodes.Document.getByIds(
      edges.map((e) => e.toId),
    );
    return edges
      .flatMap((e, i) => {
        const d = heads[i];
        return d === undefined
          ? []
          : [
              {
                d,
                position: e.position,
                delivery: corpusDelivery(e.delivery),
              },
            ];
      })
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

  // Corpora whose assembled corpus changes when this document changes.
  async collectionsIncluding(
    documentSlug: DocumentSlug,
  ): Promise<readonly string[]> {
    const doc = await this.findDoc(documentSlug);
    if (doc === undefined) return [];
    const edges = await this.g.edges.includes.findTo({
      kind: "Document",
      id: doc.id,
    });
    const cols = await this.g.nodes.Collection.getByIds(
      edges.map((edge) => edge.fromId),
    );
    return cols.flatMap((c) => (c === undefined ? [] : [c.slug]));
  }

  // — Folder→corpus links ————————————————————————————————————

  private async findFolder(slug: string) {
    const [f] = await this.g.nodes.Folder.find({
      where: (n) => n.slug.eq(slug),
      limit: 1,
    });
    return f;
  }

  // Raw direct-document + folder-include edges (slug + position), the
  // shared resolver's input. undefined when the corpus is missing.
  async entries(corpusSlug: CorpusSlug): Promise<CorpusEntries | undefined> {
    const col = await this.findCorpus(corpusSlug);
    if (col === undefined) return undefined;
    const [documentEdges, folderEdges] = await Promise.all([
      this.g.edges.includes.findFrom({ kind: "Collection", id: col.id }),
      this.g.edges.includes_folder.findFrom({
        kind: "Collection",
        id: col.id,
      }),
    ]);
    // One chunked read per member kind, not a `getById` per edge — this
    // is the corpus read path (UI and MCP), so its statement count
    // must not scale with membership. `getByIds` preserves input order,
    // so index `i` of each result belongs to edge `i`; a `undefined`
    // there is a member node that no longer exists, which is dropped.
    const [docs, folders] = await Promise.all([
      this.g.nodes.Document.getByIds(documentEdges.map((e) => e.toId)),
      this.g.nodes.Folder.getByIds(folderEdges.map((e) => e.toId)),
    ]);
    return {
      documents: documentEdges.flatMap((e, i) => {
        const d = docs[i];
        return d === undefined
          ? []
          : [
              {
                slug: d.slug,
                position: e.position,
                delivery: corpusDelivery(e.delivery),
              },
            ];
      }),
      folders: folderEdges.flatMap((e, i) => {
        const f = folders[i];
        return f === undefined
          ? []
          : [
              {
                slug: f.slug,
                position: e.position,
                delivery: corpusDelivery(e.delivery),
              },
            ];
      }),
    };
  }

  // Attach a new folder→corpus link or re-position an existing one
  // (mirrors `attach` for documents; shares the position space). An
  // idempotent re-attach returns `unchanged` for the same reason
  // documented on `attach` above.
  async attachFolder(
    corpusSlug: CorpusSlug,
    folderSlug: FolderSlug,
    position: number,
    delivery: CollectionDelivery = DEFAULT_COLLECTION_DELIVERY,
  ): Promise<AttachResult> {
    const [col, folder] = await Promise.all([
      this.findCorpus(corpusSlug),
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
      corpusDelivery(current.delivery) === delivery
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
    corpusSlug: CorpusSlug,
    folderSlug: FolderSlug,
    delivery: CollectionDelivery,
  ): Promise<{ changed: boolean } | undefined> {
    const [col, folder] = await Promise.all([
      this.findCorpus(corpusSlug),
      this.findFolder(folderSlug),
    ]);
    if (col === undefined || folder === undefined) return undefined;
    const edges = await this.g.edges.includes_folder.findFrom({
      kind: "Collection",
      id: col.id,
    });
    const current = edges.find((e) => e.toId === folder.id);
    if (current === undefined) return undefined;
    if (corpusDelivery(current.delivery) === delivery)
      return { changed: false };
    await this.g.edges.includes_folder.update(current.id, { delivery });
    return { changed: true };
  }

  async detachFolder(
    corpusSlug: CorpusSlug,
    folderSlug: FolderSlug,
  ): Promise<number | undefined> {
    const [col, folder] = await Promise.all([
      this.findCorpus(corpusSlug),
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

  // Reverse fan-out: corpora that link ANY of these folders directly
  // (the DO passes a document's folder + its ancestors).
  async collectionsIncludingFolders(
    folderSlugs: readonly string[],
  ): Promise<readonly string[]> {
    const uniqueSlugs = [...new Set(folderSlugs)];
    const folderMatches = await this.g.nodes.Folder.bulkFindByIndex(
      FOLDER_SLUG_INDEX,
      uniqueSlugs.map((slug) => ({ props: { slug } })),
      { limitPerInput: 1 },
    );
    const folders = folderMatches.flatMap(([folder]) =>
      folder === undefined ? [] : [folder],
    );
    // One `to_id IN (...)` read for the whole ancestor chain, not one per
    // folder — this runs on every document archive.
    const grouped = await this.g.edges.includes_folder.bulkFindTo(
      folders.map((f) => ({ kind: "Folder" as const, id: f.id })),
    );
    // Ids are deduped before hydration, so the surviving slugs are too:
    // a corpus linking both a folder and its ancestor appears once.
    const cols = await this.g.nodes.Collection.getByIds([
      ...new Set(grouped.flat().map((e) => e.fromId)),
    ]);
    return cols.filter((c) => c !== undefined).map((c) => c.slug);
  }

  // Every corpus with at least one folder link — the coarse v1
  // path-map-mutation fan-out set (a folder rename/move can only change
  // the expansion of a corpus that links some folder).
  async collectionsWithFolderLinks(): Promise<readonly string[]> {
    const cols = await findAll((w) => this.g.nodes.Collection.find(w));
    // "Has at least one link" only needs the first edge of each
    // corpus, so cap the fan-out and read them all in one statement.
    const grouped = await this.g.edges.includes_folder.bulkFindFrom(
      cols.map((c) => ({ kind: "Collection" as const, id: c.id })),
      { limitPerInput: 1 },
    );
    return cols
      .filter((_, i) => (grouped[i]?.length ?? 0) > 0)
      .map((c) => c.slug);
  }
}
