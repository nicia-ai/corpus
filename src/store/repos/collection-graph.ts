import type { Node } from "@nicia-ai/typegraph";

import { type Collection, FOLDER_SLUG_INDEX } from "../../graph";
import {
  asCorpusSlug,
  asDocumentSlug,
  asFolderSlug,
  type CorpusSlug,
  type DocumentSlug,
  type FolderSlug,
} from "../../ids";
import { compact } from "../../util";
import {
  type CollectionDelivery,
  corpusDelivery,
  DEFAULT_COLLECTION_DELIVERY,
} from "../domain/collection-delivery";
import { corpusRootFolderSlug } from "../domain/corpus-drive";
import type { GraphHandle } from "../handle";

import type { FolderNode } from "./folder-repo";
import { findAll } from "./paginate";

export type CorpusNode = Node<typeof Collection>;

// A corpus document as resolved from the graph: the head pinned by content
// hash + version, at its corpus-relative path. `position` is its 1-based
// rank in path order — what a CorpusVersion snapshot records.
export type CorpusDocView = Readonly<{
  slug: string;
  path: string;
  title: string;
  docVersion: number;
  contentHash: string;
  updatedAt: string;
  position: number;
}>;

export type CorpusMeta = Readonly<{
  slug: string;
  name: string;
  description?: string;
}>;

export type LegacyEntry = Readonly<{
  slug: string;
  position: number;
  delivery: CollectionDelivery;
}>;

export type LegacyCorpusEntries = Readonly<{
  corpusSlug: CorpusSlug;
  documents: readonly LegacyEntry[];
  folders: readonly LegacyEntry[];
}>;

export type CorpusFolderLink = Readonly<{
  corpusSlug: CorpusSlug;
  folderSlug: FolderSlug;
}>;

export type CorpusDocumentLink = Readonly<{
  corpusSlug: CorpusSlug;
  documentSlug: DocumentSlug;
}>;

// Corpus nodes and the one `includes_folder` link each has to its root
// folder. Owns all corpus-side graph traversal so the DO never touches
// edges directly. There is deliberately no way to link a single document
// or a second folder: membership is "under the root" and nothing else.
export class CorpusGraph {
  constructor(private readonly g: GraphHandle) {}

  async findCorpus(slug: CorpusSlug): Promise<CorpusNode | undefined> {
    const [col] = await this.g.nodes.Collection.find({
      where: (a) => a.slug.eq(slug),
      limit: 1,
    });
    return col;
  }

  createCorpus(
    fields: Readonly<{
      slug: CorpusSlug;
      name: string;
      description: string | undefined;
    }>,
  ): Promise<CorpusNode> {
    return this.g.nodes.Collection.create(
      compact({
        slug: fields.slug,
        name: fields.name,
        description: fields.description,
      }),
    );
  }

  // Edit a corpus's name/description. Slug is identity (pinned in every
  // CorpusVersion, the bundle sort key, and the root folder's name) so it
  // is never touched — which is why a rename can never change a path.
  // `description: ""` is a present value that overwrites.
  async updateCorpus(
    slug: CorpusSlug,
    fields: Readonly<{ name: string; description: string }>,
  ): Promise<CorpusNode | undefined> {
    const col = await this.findCorpus(slug);
    if (col === undefined) return undefined;
    return this.g.nodes.Collection.update(col.id, {
      name: fields.name,
      description: fields.description,
    });
  }

  async list(limit: number): Promise<readonly CorpusMeta[]> {
    return this.toMetas(await this.g.nodes.Collection.find({ limit }));
  }

  count(): Promise<number> {
    return this.g.query().from("Collection", "c").count();
  }

  // Every corpus, paginated (bundle export); `list(limit)` is the bounded
  // UI variant.
  async listAll(): Promise<readonly CorpusMeta[]> {
    return this.toMetas(await this.allNodes());
  }

  async listByCreation(): Promise<
    readonly Readonly<{ slug: CorpusSlug; createdAt: string }>[]
  > {
    return (await this.allNodes()).map((c) => ({
      slug: asCorpusSlug(c.slug),
      createdAt: c.meta.createdAt,
    }));
  }

  private allNodes(): Promise<readonly CorpusNode[]> {
    return findAll((w) => this.g.nodes.Collection.find(w));
  }

  private toMetas(cols: readonly CorpusNode[]): readonly CorpusMeta[] {
    return cols.map((c) =>
      compact({ slug: c.slug, name: c.name, description: c.description }),
    );
  }

  // — The root link ——————————————————————————————————————————

  async linkRoot(corpus: CorpusNode, folder: FolderNode): Promise<void> {
    await this.g.edges.includes_folder.create(
      { kind: "Collection", id: corpus.id },
      { kind: "Folder", id: folder.id },
      { position: 0, delivery: DEFAULT_COLLECTION_DELIVERY },
    );
  }

  // Every corpus → folder link in the project. In a project laid out as
  // drives that is exactly one per corpus, to its root.
  async folderLinks(): Promise<readonly CorpusFolderLink[]> {
    const rows = await this.g
      .query()
      .from("Collection", "c")
      .traverse("includes_folder", "e")
      .to("Folder", "f")
      .project((e) => ({ corpusSlug: e.c.slug, folderSlug: e.f.slug }))
      .execute();
    return rows.map((row) => ({
      corpusSlug: asCorpusSlug(row.corpusSlug),
      folderSlug: asFolderSlug(row.folderSlug),
    }));
  }

  async rootFolderSlug(
    corpusSlug: CorpusSlug,
  ): Promise<FolderSlug | undefined> {
    const rows = await this.g
      .query()
      .from("Collection", "c")
      .whereNode("c", (c) => c.slug.eq(corpusSlug))
      .traverse("includes_folder", "e")
      .to("Folder", "f")
      .project((e) => ({ folderSlug: e.f.slug }))
      .execute();
    const expected = corpusRootFolderSlug(corpusSlug);
    return rows.some((row) => row.folderSlug === expected)
      ? expected
      : undefined;
  }

  // The corpora that link ANY of these folders. Given a document's folder
  // chain this is the corpus it is in: only a root is ever linked.
  async collectionsIncludingFolders(
    folderSlugs: readonly string[],
  ): Promise<readonly CorpusSlug[]> {
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
    // folder — this runs on every shared-link write and document archive.
    const grouped = await this.g.edges.includes_folder.bulkFindTo(
      folders.map((f) => ({ kind: "Folder" as const, id: f.id })),
    );
    const cols = await this.g.nodes.Collection.getByIds([
      ...new Set(grouped.flat().map((e) => e.fromId)),
    ]);
    return cols.filter((c) => c !== undefined).map((c) => asCorpusSlug(c.slug));
  }

  // — The pre-drive shape (read and removed by the layout migration) ——

  // Direct corpus → document `includes` edges. Nothing creates these any
  // more; a project written before drives still carries them until its
  // one-time layout migration runs.
  async legacyDocumentLinks(): Promise<readonly CorpusDocumentLink[]> {
    const rows = await this.g
      .query()
      .from("Collection", "c")
      .traverse("includes", "e")
      .to("Document", "d")
      .project((e) => ({ corpusSlug: e.c.slug, documentSlug: e.d.slug }))
      .execute();
    return rows.map((row) => ({
      corpusSlug: asCorpusSlug(row.corpusSlug),
      documentSlug: asDocumentSlug(row.documentSlug),
    }));
  }

  // The stored pre-drive entries of every corpus, with their position and
  // tier — what the operator stats read to describe an un-migrated project.
  // A corpus's own root link is not an entry.
  async legacyEntries(): Promise<readonly LegacyCorpusEntries[]> {
    const [documentRows, folderRows] = await Promise.all([
      this.g
        .query()
        .from("Collection", "c")
        .traverse("includes", "e")
        .to("Document", "d")
        .select((ctx) => ({
          corpusSlug: ctx.c.slug,
          slug: ctx.d.slug,
          position: ctx.e.position,
          delivery: ctx.e.delivery,
        }))
        .execute(),
      this.g
        .query()
        .from("Collection", "c")
        .traverse("includes_folder", "e")
        .to("Folder", "f")
        .select((ctx) => ({
          corpusSlug: ctx.c.slug,
          slug: ctx.f.slug,
          position: ctx.e.position,
          delivery: ctx.e.delivery,
        }))
        .execute(),
    ]);
    const corpora = await this.allNodes();
    const entry = (row: (typeof documentRows)[number]): LegacyEntry => ({
      slug: row.slug,
      position: row.position,
      delivery: corpusDelivery(row.delivery),
    });
    return corpora.map((c) => ({
      corpusSlug: asCorpusSlug(c.slug),
      documents: documentRows.filter((r) => r.corpusSlug === c.slug).map(entry),
      folders: folderRows
        .filter(
          (r) =>
            r.corpusSlug === c.slug &&
            r.slug !== corpusRootFolderSlug(asCorpusSlug(c.slug)),
        )
        .map(entry),
    }));
  }

  // Remove every direct document link and every folder link that is not a
  // corpus's own root, leaving the single-root shape. Returns how many
  // edges went, so a second run reports nothing to do.
  async dropLegacyLinks(): Promise<number> {
    const corpora = await this.allNodes();
    const refs = corpora.map((c) => ({
      kind: "Collection" as const,
      id: c.id,
    }));
    const [documentEdges, folderEdges] = await Promise.all([
      this.g.edges.includes.bulkFindFrom(refs),
      this.g.edges.includes_folder.bulkFindFrom(refs),
    ]);
    let dropped = 0;
    for (const edge of documentEdges.flat()) {
      await this.g.edges.includes.hardDelete(edge.id);
      dropped += 1;
    }
    for (const [i, corpus] of corpora.entries()) {
      const edges = folderEdges[i] ?? [];
      const folders = await this.g.nodes.Folder.getByIds(
        edges.map((edge) => edge.toId),
      );
      const rootSlug = corpusRootFolderSlug(asCorpusSlug(corpus.slug));
      for (const [j, edge] of edges.entries()) {
        if (folders[j]?.slug === rootSlug) continue;
        await this.g.edges.includes_folder.hardDelete(edge.id);
        dropped += 1;
      }
    }
    return dropped;
  }

  // Remove a corpus outright: its root link, every membership snapshot
  // (a deleted corpus must stop pinning document versions against
  // retention, and must leave the bundle), then the node. The caller has
  // already dealt with the root folder's contents.
  async deleteCorpus(corpus: CorpusNode): Promise<void> {
    const from = { kind: "Collection" as const, id: corpus.id };
    const [folderEdges, versionEdges] = await Promise.all([
      this.g.edges.includes_folder.findFrom(from),
      this.g.edges.version_of_collection.findFrom(from),
    ]);
    for (const edge of folderEdges) {
      await this.g.edges.includes_folder.hardDelete(edge.id);
    }
    for (const edge of versionEdges) {
      await this.g.edges.version_of_collection.hardDelete(edge.id);
      await this.g.nodes.CollectionVersion.hardDelete(edge.toId);
    }
    await this.g.nodes.Collection.hardDelete(corpus.id);
  }
}
