import type {
  CallerRef,
  CollectionSlug,
  DocumentSlug,
  ProjectId,
} from "../ids";
import type {
  AddSuggestionMessageResult,
  CreateDocProposalResult,
  CreateSuggestionResult,
  ProposalResult,
  SuggestCreateInput,
} from "../project-store/commands/suggestions";
import type { CollectionDelivery } from "../store/domain/collection-expand";
import type { VerifyResult } from "../store/domain/verify";

// The per-request MCP executor port. `callerRef` carries the namespaced
// caller identity (`apikey:<id>` | `oauth:<sub>:connection:<id>`) so downstream code can
// attribute reads to a stable caller in the durable event stream.
export type McpExecutor = Readonly<{
  callerRef: CallerRef;
  baseUrl: string;
  projectId: ProjectId;
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
            kind: "path" | "wiki";
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
  // Proposal writes — the only writes on the port, and both are proposals
  // pending human review, never applied by the agent. suggestEdit proposes a
  // full replacement body for one document in the bound Collection (diffed
  // into per-hunk suggestions); `baseDocVersion` is the version the agent
  // read — a mismatch with head yields the `conflict` result so the agent
  // re-reads rather than proposing blind. `callerRef` is the enforced
  // author on both (see scoped-executor).
  suggestEdit: (
    callerRef: CallerRef,
    slug: DocumentSlug,
    proposedMarkdown: string,
    baseDocVersion: number,
  ) => Promise<CreateSuggestionResult>;
  // suggestCreate proposes a NEW document (slug or Corpus path that resolves
  // to nothing + baseDocVersion 0 at the tool layer). A human apply creates
  // the document and attaches it to the proposing connection's bound
  // Collection as `reference`. `originCollectionSlug` is NOT caller data:
  // the scoped executor overwrites it with its bound Collection — it is
  // optional here only so the port and the DO method share one shape.
  suggestCreate: (
    callerRef: CallerRef,
    input: SuggestCreateInput,
  ) => Promise<CreateDocProposalResult>;
  // Only the exact callerRef that created a proposal can retrieve its
  // result. The scoped executor pins identity and the DO re-checks ownership.
  proposalResult: (
    callerRef: CallerRef,
    proposalId: number,
  ) => Promise<ProposalResult>;
  // Proposal-scoped conversation only. The DO accepts a reply when this
  // caller created the still-open proposal; general document comments are
  // intentionally absent from the MCP port.
  replyToProposal: (
    callerRef: CallerRef,
    proposalId: number,
    body: string,
  ) => Promise<AddSuggestionMessageResult>;
}>;
