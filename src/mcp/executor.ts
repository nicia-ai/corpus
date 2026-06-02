import type { CallerRef, CollectionSlug, DocumentSlug } from "../ids";
import type { CollectionDelivery } from "../store/domain/collection-expand";
import type { VerifyResult } from "../store/domain/verify";

// The per-request MCP executor port. `callerRef` carries the namespaced
// caller identity (`apikey:<id>` | `oauth:<sub>`) so downstream code can
// attribute reads to a stable caller in the durable event stream.
export type McpExecutor = Readonly<{
  callerRef: CallerRef;
  listCollections: () => Promise<
    readonly {
      slug: string;
      name: string;
      description?: string;
    }[]
  >;
  listDocuments: () => Promise<
    readonly {
      slug: string;
      title: string;
      docVersion: number;
      size: number;
      path?: string;
      delivery?: CollectionDelivery;
    }[]
  >;
  readCollection: (slug: CollectionSlug) => Promise<
    | { found: false }
    | {
        found: true;
        corpus: string;
        documents: readonly {
          slug: string;
          docVersion: number;
          size: number;
        }[];
      }
  >;
  collectionMembers: (
    slug: CollectionSlug,
  ) => Promise<readonly string[] | undefined>;
  getDocument: (
    slug: DocumentSlug,
  ) => Promise<
    | { slug: string; title: string; markdown: string; docVersion: number }
    | undefined
  >;
  verifyHistory: (slug?: DocumentSlug) => Promise<VerifyResult>;
  collectionOutline: (slug: CollectionSlug) => Promise<
    | { found: false }
    | {
        found: true;
        collection: string;
        name: string;
        documents: readonly {
          slug: string;
          path: string;
          title: string;
          docVersion: number;
          delivery?: CollectionDelivery;
          links: readonly {
            target: string;
            resolvedPath: string | null;
            documentSlug: string | null;
            inCollection: boolean;
          }[];
        }[];
      }
  >;
  recordRead: (
    callerRef: CallerRef,
    collectionSlug: string,
    versionCapturedAtRead: Readonly<Record<string, number>>,
  ) => Promise<void>;
}>;
