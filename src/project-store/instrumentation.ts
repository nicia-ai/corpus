import {
  type CollectionChange,
  type CollectionMetadata,
  CollectionMetadataSchema,
  type DocumentChange,
} from "../store/domain/change-events";
import {
  events as buildEvent,
  type InstrumentationEvent,
} from "../store/domain/instrumentation-events";
import { compact } from "../util";

function collectionMetadataFromChange(
  side: Readonly<Record<string, unknown>> | undefined,
): CollectionMetadata | undefined {
  if (side === undefined) return undefined;
  const parsed = CollectionMetadataSchema.safeParse(side);
  if (!parsed.success) {
    console.warn(
      "collectionMetadataFromChange: schema mismatch (audit data dropped)",
      { issues: parsed.error.issues },
    );
    return undefined;
  }
  return parsed.data;
}

export function documentInstrumentationEvent(
  change: DocumentChange,
): InstrumentationEvent {
  return change.kind === "document.created"
    ? buildEvent.documentCreated({
        slug: change.slug,
        docVersion: change.docVersion,
        title: change.title,
        contentHash: change.contentHash ?? "",
        changedBy: change.changedBy,
      })
    : change.kind === "document.updated"
      ? buildEvent.documentUpdated({
          slug: change.slug,
          docVersion: change.docVersion,
          title: change.title,
          contentHash: change.contentHash ?? "",
          changedBy: change.changedBy,
        })
      : change.kind === "document.renamed"
        ? buildEvent.documentRenamed({
            slug: change.slug,
            docVersion: change.docVersion,
            title: change.title,
            changedBy: change.changedBy,
          })
        : change.kind === "document.archived"
          ? buildEvent.documentArchived({
              slug: change.slug,
              docVersion: change.docVersion,
              changedBy: change.changedBy,
            })
          : buildEvent.documentFilenameChanged({
              slug: change.slug,
              docVersion: change.docVersion,
              title: change.title,
              changedBy: change.changedBy,
            });
}

export function collectionInstrumentationEvent(
  change: CollectionChange,
): InstrumentationEvent {
  const folderSlug =
    typeof change.before?.folderSlug === "string"
      ? change.before.folderSlug
      : typeof change.after?.folderSlug === "string"
        ? change.after.folderSlug
        : undefined;
  const rawReason = change.after?.reason;
  const reason: "delivery-changed" | "folder-tree-changed" | undefined =
    rawReason === "delivery-changed" || rawReason === "folder-tree-changed"
      ? rawReason
      : undefined;
  const rawDelivery = change.after?.delivery;
  const delivery: "core" | "reference" | undefined =
    rawDelivery === "core" || rawDelivery === "reference"
      ? rawDelivery
      : undefined;

  switch (change.kind) {
    case "collection.created":
      return buildEvent.collectionCreated({
        collectionSlug: change.collectionSlug,
        changedBy: change.changedBy,
      });
    case "collection.updated":
      return buildEvent.collectionUpdated(
        compact({
          collectionSlug: change.collectionSlug,
          before: collectionMetadataFromChange(change.before),
          after: collectionMetadataFromChange(change.after),
          changedBy: change.changedBy,
        }),
      );
    case "collection.attached":
      return buildEvent.collectionAttached(
        compact({
          collectionSlug: change.collectionSlug,
          documentSlug: change.documentSlug,
          folderSlug,
          position:
            typeof change.after?.position === "number"
              ? change.after.position
              : 0,
          changedBy: change.changedBy,
        }),
      );
    case "collection.detached":
      return buildEvent.collectionDetached(
        compact({
          collectionSlug: change.collectionSlug,
          documentSlug: change.documentSlug,
          folderSlug,
          changedBy: change.changedBy,
        }),
      );
    case "collection.reordered": {
      const resolvedReason:
        | "delivery-changed"
        | "folder-tree-changed"
        | "drag-reorder" = reason ?? "drag-reorder";
      return buildEvent.collectionReordered(
        compact({
          collectionSlug: change.collectionSlug,
          reason: resolvedReason,
          documentSlug: change.documentSlug,
          folderSlug,
          delivery,
          changedBy: change.changedBy,
        }),
      );
    }
  }
}
