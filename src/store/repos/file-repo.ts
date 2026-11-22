import { type Node, sum } from "@nicia-ai/typegraph";

import type { StoredFile } from "../../graph";
import { asFileSlug, type FileSlug, type FolderSlug } from "../../ids";
import type { GraphHandle } from "../handle";

export type FileNode = Node<typeof StoredFile>;

export type NewFile = Readonly<{
  slug: FileSlug;
  filename: string;
  contentHash: string;
  contentType: string;
  size: number;
  createdAt: string;
}>;

// A file as plain data for a folder-subtree walk (move, delete cascade).
export type FolderFile = Readonly<{ slug: FileSlug; filename: string }>;

// All File node and `file_in_folder` edge access. A file's name competes with
// documents and folders in its parent's one namespace; that cross-type check
// lives in `FolderRepo.siblingSegments`, which asks this repo for the live
// files of a folder. The bytes are not here (R2, via `ObjectStore`): this is
// the metadata the DO writes in the same transaction as the change event.
// Lookups are by slug, by (folder, name) and by content hash, the three
// questions the upload, the app and — later — the mirror and CLI ask.
export class FileRepo {
  constructor(private readonly g: GraphHandle) {}

  async find(slug: FileSlug): Promise<FileNode | undefined> {
    const [node] = await this.g.nodes.File.find({
      where: (f) => f.slug.eq(slug),
      limit: 1,
    });
    return node;
  }

  // The live files directly in a folder (soft-deleted ones hold no name).
  async liveIn(folderSlug: string): Promise<readonly FileNode[]> {
    return this.g
      .query()
      .from("Folder", "f")
      .whereNode("f", (f) => f.slug.eq(folderSlug))
      .traverse("file_in_folder", "e", { direction: "in" })
      .to("File", "file")
      .select((ctx) => ctx.file)
      .execute()
      .then((files) => files.filter((file) => file.deletedAt === undefined));
  }

  async at(
    folderSlug: string,
    filename: string,
  ): Promise<FileNode | undefined> {
    return (await this.liveIn(folderSlug)).find((f) => f.filename === filename);
  }

  // Any live file with these bytes: the authority for "may this project's
  // member read this hash". Project-level, since a member already sees every
  // page of the project.
  async liveByHash(contentHash: string): Promise<FileNode | undefined> {
    const [node] = await this.g.nodes.File.find({
      where: (f) => f.contentHash.eq(contentHash).and(f.deletedAt.isNull()),
      limit: 1,
    });
    return node;
  }

  async create(
    file: NewFile,
    folderSlug: FolderSlug,
  ): Promise<FileNode | undefined> {
    const [folder] = await this.g.nodes.Folder.find({
      where: (f) => f.slug.eq(folderSlug),
      limit: 1,
    });
    if (folder === undefined) return undefined;
    const node = await this.g.nodes.File.create(file);
    await this.g.edges.file_in_folder.create(
      { kind: "File", id: node.id },
      { kind: "Folder", id: folder.id },
      {},
    );
    return node;
  }

  // Every live file with the folder it is in, for the corpus tree.
  async listLive(): Promise<
    readonly Readonly<{ node: FileNode; folderSlug: string }>[]
  > {
    const rows = await this.g
      .query()
      .from("File", "f")
      .traverse("file_in_folder", "e")
      .to("Folder", "folder")
      .select((ctx) => ({ node: ctx.f, folderSlug: ctx.folder.slug }))
      .execute();
    return rows.filter((row) => row.node.deletedAt === undefined);
  }

  // Bytes of live files, the figure the project quota is measured against.
  async liveBytes(): Promise<number> {
    const [row] = await this.g
      .query()
      .from("File", "f")
      .whereNode("f", (f) => f.deletedAt.isNull())
      .aggregate({ total: sum("f", "size") })
      .execute();
    return row?.total ?? 0;
  }

  liveCount(): Promise<number> {
    return this.g
      .query()
      .from("File", "f")
      .whereNode("f", (f) => f.deletedAt.isNull())
      .count();
  }

  // Every hash a surviving node references, soft-deleted ones included: the
  // orphan sweep keeps an object until the reaper has removed the last node
  // naming it.
  async referencedHashes(): Promise<readonly string[]> {
    const rows = await this.g
      .query()
      .from("File", "f")
      .project((ctx) => ({ hash: ctx.f.contentHash }))
      .execute();
    return [...new Set(rows.map((row) => row.hash))];
  }

  // Soft-delete: stamp `deletedAt` so the file holds no name and no quota.
  // The caller has already detached it from its folder (the folder is going
  // away). Returns the slugs for the change events.
  async softDelete(
    nodes: readonly FileNode[],
    deletedAt: string,
  ): Promise<readonly FileSlug[]> {
    for (const node of nodes) {
      await this.g.nodes.File.update(node.id, { deletedAt });
    }
    return nodes.map((node) => asFileSlug(node.slug));
  }

  // Replace a live file's bytes in place: the slug, name and place stay, the
  // content address, type and size move. The old bytes stay in R2 until the
  // orphan sweep finds nothing referencing them.
  async replaceContent(
    node: FileNode,
    next: Readonly<{ contentHash: string; contentType: string; size: number }>,
  ): Promise<void> {
    await this.g.nodes.File.update(node.id, next);
  }

  async setFilename(node: FileNode, filename: string): Promise<void> {
    await this.g.nodes.File.update(node.id, { filename });
  }

  // Give a file a new home folder. Reconstruction only (no sibling-namespace
  // check), like `FolderRepo.rehomeDocument`.
  async rehome(slug: FileSlug, folderSlug: FolderSlug): Promise<void> {
    const node = await this.find(slug);
    const [folder] = await this.g.nodes.Folder.find({
      where: (f) => f.slug.eq(folderSlug),
      limit: 1,
    });
    if (node === undefined || folder === undefined) return;
    const edges = await this.g.edges.file_in_folder.findFrom({
      kind: "File",
      id: node.id,
    });
    for (const edge of edges) {
      await this.g.edges.file_in_folder.hardDelete(edge.id);
    }
    await this.g.edges.file_in_folder.create(
      { kind: "File", id: node.id },
      { kind: "Folder", id: folder.id },
      {},
    );
  }

  // Soft-delete one live file: detached from its folder (so its name is free)
  // and stamped `deletedAt`. False when it is missing or already deleted.
  async deleteOne(slug: FileSlug, deletedAt: string): Promise<boolean> {
    const node = await this.find(slug);
    if (node === undefined || node.deletedAt !== undefined) return false;
    const edges = await this.g.edges.file_in_folder.findFrom({
      kind: "File",
      id: node.id,
    });
    for (const edge of edges) {
      await this.g.edges.file_in_folder.hardDelete(edge.id);
    }
    await this.softDelete([node], deletedAt);
    return true;
  }

  // The folder a live file is in, or undefined.
  async folderOf(slug: FileSlug): Promise<string | undefined> {
    const node = await this.find(slug);
    if (node === undefined || node.deletedAt !== undefined) return undefined;
    const [edge] = await this.g.edges.file_in_folder.findFrom({
      kind: "File",
      id: node.id,
    });
    if (edge === undefined) return undefined;
    return (await this.g.nodes.Folder.getById(edge.toId))?.slug;
  }

  // Retention: remove soft-deleted files whose window has passed. `hardDelete`
  // per node is correct here (see AGENTS.md): the store's `bulkDelete` is a
  // soft delete. A head file (`deletedAt` unset) is never selected.
  async reapDeletedBefore(cutoffIso: string): Promise<number> {
    const expired = await this.g.nodes.File.find({
      where: (f) => f.deletedAt.isNotNull().and(f.deletedAt.lt(cutoffIso)),
    });
    for (const node of expired) {
      await this.g.nodes.File.hardDelete(node.id);
    }
    return expired.length;
  }
}
