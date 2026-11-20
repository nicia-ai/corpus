import {
  asDocumentSlug,
  type CallerRef,
  type CorpusSlug,
  type ProjectId,
} from "./ids";
import type { McpExecutor } from "./mcp";

// The read-side scope for an MCP request. The Connection's bound
// Corpus is the agent's entire world; every McpExecutor method is
// filtered against the preflight-resolved `members` set so reads
// outside the Corpus (by tool, resource, or link projection) are
// impossible. Pure filtering over the inner port — no new DO methods.
//
// The bound Corpus's *existence* is `respondMcp`'s preflight job;
// by the time `scopedExecutor` runs, members has been resolved and a
// missing Corpus already became HTTP 403.
//
// A slug-mismatch never reveals the bound Corpus's name to a
// confused agent: the same `found: false` shape goes out as for a
// truly unknown Corpus.

// `inner` is the raw ProjectStore DO stub — it doesn't carry the
// per-request identity/route context, so those fields are omitted here and
// filled from closure-bound arguments on the returned executor.
export function scopedExecutor(
  inner: Omit<McpExecutor, "callerRef" | "baseUrl" | "projectId">,
  boundSlug: CorpusSlug,
  members: readonly string[],
  callerRef: CallerRef,
  location: Readonly<{ baseUrl: string; projectId: ProjectId }>,
): McpExecutor {
  const memberSet = new Set<string>(members);
  // An agent listing the Corpus is the freshness moment: record which
  // version of each document it was shown. The inner method swallows
  // failures, so a momentary EventLogStore blip never fails the read.
  const recordListing = (
    documents: readonly Readonly<{ slug: string; docVersion: number }>[],
  ): Promise<void> => {
    const versionMap: Record<string, number> = {};
    for (const d of documents) {
      if (memberSet.has(d.slug)) versionMap[d.slug] = d.docVersion;
    }
    return inner.recordRead(callerRef, boundSlug, versionMap);
  };
  return {
    callerRef,
    baseUrl: location.baseUrl,
    projectId: location.projectId,
    // Only the bound Corpus is reachable. Project the inner DO's
    // `CorpusMeta` down to the MCP port shape explicitly, so a field added
    // to it later cannot leak to an agent through JSON.stringify in
    // handleMcp.
    listCorpora: async () => {
      const all = await inner.listCorpora();
      return all
        .filter((c) => c.slug === boundSlug)
        .map((c) =>
          c.description === undefined
            ? { slug: c.slug, name: c.name }
            : { slug: c.slug, name: c.name, description: c.description },
        );
    },

    // The agent's whole world: the bound Corpus's documents in path order,
    // each at its Corpus-relative path. Built from the outline (which is
    // what orders and paths them) and never from the project-wide list's
    // own rows — those carry other corpora's documents and project-scope
    // fields (`filename`, `folderSlug`, `corpusSlug`, `updatedAt`). If the
    // bound Corpus vanished mid-request the outline is not-found and the
    // answer is empty, never a fallback to the wider list.
    listDocuments: async () => {
      const [all, outline] = await Promise.all([
        inner.listDocuments(),
        inner.corpusOutline(boundSlug),
      ]);
      if (!outline.found) return [];
      const sizeBySlug = new Map(all.map((d) => [d.slug, d.size]));
      const documents = outline.documents
        .filter((d) => memberSet.has(d.slug))
        .map((d) => ({
          slug: d.slug,
          title: d.title,
          docVersion: d.docVersion,
          size: sizeBySlug.get(d.slug) ?? 0,
          path: d.path,
        }));
      await recordListing(documents);
      return documents;
    },

    // The preflight already used `inner.corpusMembers` directly on the
    // raw DO stub; the scoped wrapper only ever serves the bound slug.
    corpusMembers: async (slug) =>
      slug === boundSlug ? inner.corpusMembers(slug) : undefined,

    // Required by the McpExecutor port (handleMcp does not call it
    // directly today), but a public method on a scoped wrapper must
    // not be spoofable. Enforce closure-bound identity and scope here
    // so callers can't forge `(callerRef, corpusSlug)` against any
    // record path — only the bound caller + bound Corpus are
    // acceptable. Also filter `versionMap` keys to the bound member
    // set so a caller can't smuggle a non-member slug into the durable
    // event payload (`versionCapturedAtRead`). The DO's `recordRead`
    // does no scope check; this is the only line that can.
    recordRead: (suppliedCallerRef, corpusSlug, versionMap) => {
      if (suppliedCallerRef !== callerRef) return Promise.resolve();
      if (corpusSlug !== boundSlug) return Promise.resolve();
      const filtered: Record<string, number> = {};
      for (const [slug, version] of Object.entries(versionMap)) {
        if (memberSet.has(slug)) filtered[slug] = version;
      }
      return inner.recordRead(callerRef, corpusSlug, filtered);
    },

    // The executor's proposal writes. Same closure-bound caller identity as
    // recordRead, then the same membership gate as getDocument: a
    // non-member (or unknown) slug returns the `missing` result so the
    // handler 404s without revealing that the slug exists elsewhere, and
    // no suggestion row is ever written outside the bound Corpus. The
    // agent only ever proposes; createSuggestion stores it pending a human.
    suggestEdit: (
      suppliedCallerRef,
      slug,
      proposedMarkdown,
      baseDocVersion,
    ) => {
      if (suppliedCallerRef !== callerRef || !memberSet.has(slug)) {
        return Promise.resolve({
          ok: false as const,
          reason: "missing" as const,
        });
      }
      // `memberSet` is a snapshot from the start of the request; pinning
      // the bound Corpus lets the DO re-check, inside the write, where the
      // document is NOW.
      return inner.suggestEdit(
        callerRef,
        slug,
        proposedMarkdown,
        baseDocVersion,
        boundSlug,
      );
    },

    // Create-proposals have no membership to gate (the document doesn't
    // exist yet); scope is enforced by pinning the origin to the bound
    // Corpus — whatever the caller put in `originCollectionSlug` is
    // overwritten, so an applied proposal can only ever be created here.
    suggestCreate: (suppliedCallerRef, input) => {
      if (suppliedCallerRef !== callerRef) {
        return Promise.resolve({
          ok: false as const,
          reason: "invalid" as const,
        });
      }
      return inner.suggestCreate(callerRef, {
        ...input,
        originCollectionSlug: boundSlug,
      });
    },

    proposalResult: (suppliedCallerRef, proposalId) =>
      suppliedCallerRef === callerRef
        ? inner.proposalResult(callerRef, proposalId, boundSlug)
        : Promise.resolve({ found: false as const }),

    replyToProposal: (suppliedCallerRef, proposalId, body) =>
      suppliedCallerRef === callerRef
        ? inner.replyToProposal(callerRef, proposalId, body, boundSlug)
        : Promise.resolve({
            ok: false as const,
            reason: "missing" as const,
          }),

    // Membership-gate. A non-member slug is indistinguishable from a
    // truly unknown document (the agent cannot probe to learn what
    // exists outside its Corpus).
    getDocument: async (slug) =>
      memberSet.has(slug) ? inner.getDocument(slug) : undefined,

    // Per-slug: gate on membership; non-member returns the empty-verify
    // shape, never revealing "this slug exists somewhere." Whole-scope
    // (no slug): fan out one verify per bound-Corpus member in
    // parallel — each is its own DO RPC, and a sequential loop would
    // serialize N round-trips. Loses first-failure short-circuit, but
    // the common case is all-ok where short-circuiting doesn't help;
    // when broken, the first broken result still surfaces.
    verifyHistory: async (slug) => {
      if (slug !== undefined) {
        if (!memberSet.has(slug)) return { ok: true };
        return inner.verifyHistory(slug);
      }
      const results = await Promise.all(
        [...memberSet].map((m) => inner.verifyHistory(asDocumentSlug(m))),
      );
      return results.find((r) => !r.ok) ?? { ok: true };
    },

    // The outline is the agent's hierarchy + link graph in one shot, so
    // link projection is where reverse-leak is the most expensive: a link
    // into ANOTHER corpus resolves on the web, and its `documentSlug` /
    // `resolvedPath` would enumerate a document the agent cannot read.
    // Collapse such links to the dangling / external pass-through shape —
    // same shape an unresolved relative link already gets.
    corpusOutline: async (slug) => {
      if (slug !== boundSlug) return { found: false };
      const o = await inner.corpusOutline(slug);
      if (!o.found) return { found: false };
      await recordListing(o.documents);
      return {
        found: true,

        corpus: o.corpus,
        name: o.name,
        documents: o.documents
          .filter((d) => memberSet.has(d.slug))
          .map((d) => ({
            slug: d.slug,
            path: d.path,
            title: d.title,
            docVersion: d.docVersion,
            links: d.links.map((l) =>
              l.documentSlug !== null && !memberSet.has(l.documentSlug)
                ? {
                    target: l.target,
                    kind: l.kind,
                    resolvedPath: null,
                    documentSlug: null,
                    inCorpus: false,
                  }
                : l,
            ),
          })),
      };
    },
  };
}
