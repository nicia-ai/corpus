import type { CallerRef, CorpusSlug, DocumentSlug, ProjectId } from "../ids";
import type {
  AddSuggestionMessageResult,
  CreateDocProposalResult,
  CreateSuggestionResult,
  ProposalResult,
  SuggestCreateInput,
} from "../project-store/commands/suggestions";
import type { VerifyResult } from "../store/domain/verify";
import type { ObjectStore } from "../store/repos/object-store";

export type McpFile = Readonly<{
  path: string;
  size: number;
  contentType: string;
}>;

export type McpFileRef = Readonly<
  McpFile & { name: string; contentHash: string }
>;

// The per-request MCP executor port. `callerRef` carries the namespaced
// caller identity (`apikey:<id>` | `oauth:<sub>:connection:<id>`) so downstream code can
// attribute reads to a stable caller in the durable event stream.
export type McpExecutor = Readonly<{
  callerRef: CallerRef;
  baseUrl: string;
  projectId: ProjectId;
  listCorpora: () => Promise<
    readonly {
      slug: string;
      name: string;
      description?: string;
    }[]
  >;
  // The bound Corpus's documents in path order. `path` is relative to the
  // Corpus root — the only path an agent ever sees.
  listDocuments: () => Promise<
    readonly {
      slug: string;
      title: string;
      docVersion: number;
      size: number;
      path: string;
    }[]
  >;
  // The bound Corpus's image / attachment files in path order, a sibling of
  // `listDocuments` so the document listing contract is untouched.
  listFiles: () => Promise<readonly McpFile[]>;
  // The file in the bound Corpus that `path` names: relative to the page
  // `document` when given (a `src` as written in it), else to the Corpus
  // root. Undefined when nothing is there, the path escapes the Corpus, or
  // `document` is not in it.
  getFile: (
    target: Readonly<{ path: string; document?: DocumentSlug }>,
  ) => Promise<McpFileRef | undefined>;
  // The bytes behind a file, or undefined when this deployment has no file
  // storage (`FILES` unbound). Keys are built from `projectId`.
  objects: ObjectStore | undefined;
  corpusMembers: (slug: CorpusSlug) => Promise<readonly string[] | undefined>;
  getDocument: (
    slug: DocumentSlug,
  ) => Promise<
    | { slug: string; title: string; markdown: string; docVersion: number }
    | undefined
  >;
  verifyHistory: (slug?: DocumentSlug) => Promise<VerifyResult>;
  corpusOutline: (slug: CorpusSlug) => Promise<
    | { found: false }
    | {
        found: true;
        corpus: string;
        name: string;
        documents: readonly {
          slug: string;
          path: string;
          title: string;
          docVersion: number;
          links: readonly {
            target: string;
            kind: "path" | "wiki";
            resolvedPath: string | null;
            documentSlug: string | null;
            inCorpus: boolean;
          }[];
        }[];
      }
  >;
  recordRead: (
    callerRef: CallerRef,
    corpusSlug: string,
    versionCapturedAtRead: Readonly<Record<string, number>>,
  ) => Promise<void>;
  // Proposal writes — the only writes on the port, and both are proposals
  // pending human review, never applied by the agent. suggestEdit proposes a
  // full replacement body for one document in the bound Corpus (diffed
  // into per-hunk suggestions); `baseDocVersion` is the version the agent
  // read — a mismatch with head yields the `conflict` result so the agent
  // re-reads rather than proposing blind. `callerRef` is the enforced
  // author on both (see scoped-executor). `inCorpus` is NOT caller data:
  // the scoped executor overwrites it with its bound Corpus, and the DO
  // re-checks inside the write that the document is in that Corpus NOW —
  // a document moved out since the request began is `missing`.
  suggestEdit: (
    callerRef: CallerRef,
    slug: DocumentSlug,
    proposedMarkdown: string,
    baseDocVersion: number,
    inCorpus?: CorpusSlug,
  ) => Promise<CreateSuggestionResult>;
  // suggestCreate proposes a NEW document (slug or Corpus path that resolves
  // to nothing + baseDocVersion 0 at the tool layer). A human apply creates
  // the document in the proposing connection's bound Corpus, at the
  // proposed Corpus-relative path. `originCollectionSlug` is NOT caller data:
  // the scoped executor overwrites it with its bound Corpus — it is
  // optional here only so the port and the DO method share one shape.
  suggestCreate: (
    callerRef: CallerRef,
    input: SuggestCreateInput,
  ) => Promise<CreateDocProposalResult>;
  // Only the exact callerRef that created a proposal can retrieve its
  // result. The scoped executor pins identity and the DO re-checks ownership.
  // `inCorpus` is pinned by the scoped executor like `suggestEdit`'s: the DO
  // re-checks the proposal still belongs to that corpus, now.
  proposalResult: (
    callerRef: CallerRef,
    proposalId: number,
    inCorpus?: CorpusSlug,
  ) => Promise<ProposalResult>;
  // Proposal-scoped conversation only. The DO accepts a reply when this
  // caller created the still-open proposal; general document comments are
  // intentionally absent from the MCP port.
  replyToProposal: (
    callerRef: CallerRef,
    proposalId: number,
    body: string,
    inCorpus?: CorpusSlug,
  ) => Promise<AddSuggestionMessageResult>;
}>;
