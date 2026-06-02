import { asCollectionSlug } from "../../ids";
import {
  collectionFolderTreeChanged,
  type CollectionChange,
} from "../../store/domain/change-events";
import type { ProjectUnit } from "../unit";

export async function folderTreeFanOutChanges(
  u: ProjectUnit,
  changedBy: string,
  now: string,
): Promise<readonly CollectionChange[]> {
  const out: CollectionChange[] = [];
  for (const slug of await u.cols.collectionsWithFolderLinks()) {
    out.push(
      collectionFolderTreeChanged({
        collectionSlug: asCollectionSlug(slug),
        changedBy,
        changedAt: now,
      }),
    );
  }
  return out;
}
