import type { Node } from "@nicia-ai/typegraph";

import type { Document } from "../../graph";
import type { DocumentSlug } from "../../ids";
import type { GraphHandle } from "../handle";

import { findAll } from "./paginate";

export type DocumentNode = Node<typeof Document>;

export type DocumentFields = Readonly<{
  title: string;
  filename: string;
  contentHash: string;
  docVersion: number;
  updatedAt: string;
}>;

// All Document node reads/writes. The node carries only the head pointer
// (`contentHash`), never inline markdown — bytes live in the blob store.
// `put` owns the create-vs-update branch (so the DO never handles a node
// id) and returns the node so the caller can link its version edge.
export class DocumentRepo {
  constructor(private readonly g: GraphHandle) {}

  async find(slug: DocumentSlug): Promise<DocumentNode | undefined> {
    const [node] = await this.g.nodes.Document.find({
      where: (d) => d.slug.eq(slug),
      limit: 1,
    });
    return node;
  }

  list(limit: number): Promise<readonly DocumentNode[]> {
    return this.g.nodes.Document.find({ limit });
  }

  // The whole document set, paginated. Use where a caller needs *every*
  // document (reap, bundle export, slug-collision scan); `list(limit)` is for
  // callers that deliberately bound the result.
  listAll(): Promise<readonly DocumentNode[]> {
    return findAll((w) => this.g.nodes.Document.find(w));
  }

  async put(
    slug: DocumentSlug,
    fields: DocumentFields,
    existing: DocumentNode | undefined,
  ): Promise<DocumentNode> {
    return existing === undefined
      ? this.g.nodes.Document.create({ slug, ...fields })
      : this.g.nodes.Document.update(existing.id, fields);
  }

  // Title is head-pointer metadata, not content — a rename touches only
  // `title`/`updatedAt` (partial-merge update), never `contentHash` or
  // `docVersion`, so it does NOT cut a DocumentVersion and the
  // content-addressed chain is untouched.
  async rename(
    node: DocumentNode,
    title: string,
    updatedAt: string,
  ): Promise<DocumentNode> {
    return this.g.nodes.Document.update(node.id, { title, updatedAt });
  }

  // `filename` is also head-pointer metadata (the path segment for link
  // resolution), not content — same partial-merge primitive as
  // `rename`, deliberately a distinct method so the title-only contract
  // of `rename` is never widened. No `contentHash`/`docVersion` touch.
  async setFilename(
    node: DocumentNode,
    filename: string,
    updatedAt: string,
  ): Promise<DocumentNode> {
    return this.g.nodes.Document.update(node.id, { filename, updatedAt });
  }

  // Soft-delete: stamp `archivedAt` on the head only (same partial-merge
  // primitive as `rename`/`setFilename`). The content-addressed
  // `DocumentVersion` chain and blobs are deliberately untouched so
  // existing CollectionVersion snapshots and bundle export still resolve.
  async archive(node: DocumentNode, archivedAt: string): Promise<DocumentNode> {
    return this.g.nodes.Document.update(node.id, { archivedAt });
  }
}
