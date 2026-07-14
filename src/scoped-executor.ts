import { asDocumentSlug, type CallerRef, type CollectionSlug } from "./ids";
import type { McpExecutor } from "./mcp";
import { compact } from "./util";

// The read-side scope for an MCP request. The Connection's bound
// Collection is the agent's entire world; every McpExecutor method is
// filtered against the preflight-resolved `members` set so reads
// outside the Collection (by tool, resource, or link projection) are
// impossible. Pure filtering over the inner port — no new DO methods.
//
// The bound Collection's *existence* is `respondMcp`'s preflight job;
// by the time `scopedExecutor` runs, members has been resolved and a
// missing Collection already became HTTP 403.
//
// A slug-mismatch never reveals the bound Collection's name to a
// confused agent: the same `found: false` shape goes out as for a
// truly unknown Collection.

// `inner` is the raw ProjectStore DO stub — it doesn't carry the
// per-request `callerRef`, so it's typed as `Omit<McpExecutor,
// "callerRef">` to make that explicit. The returned executor fills the
// field in from the per-request argument.
export function scopedExecutor(
  inner: Omit<McpExecutor, "callerRef">,
  boundSlug: CollectionSlug,
  members: readonly string[],
  callerRef: CallerRef,
): McpExecutor {
  const memberSet = new Set<string>(members);
  return {
    callerRef,
    // Only the bound Collection is reachable. The inner DO returns the
    // builder-side `CollectionMeta` (which carries authoring-only fields
    // like `alwaysIncludeBudgetTokens`); project it down to the MCP port
    // shape here so that information cannot leak to an agent through
    // JSON.stringify in handleMcp.
    listCollections: async () => {
      const all = await inner.listCollections();
      return all
        .filter((c) => c.slug === boundSlug)
        .map((c) =>
          c.description === undefined
            ? { slug: c.slug, name: c.name }
            : { slug: c.slug, name: c.name, description: c.description },
        );
    },

    // The relevance scope an agent should work within (and the only
    // scope it can: getDocument below is membership-gated). The inner
    // DO returns wider fields (`filename`, `folderSlug`, `updatedAt`)
    // than the McpExecutor port declares; project explicitly so internal
    // project-scope identifiers cannot reach the agent via JSON.stringify.
    listDocuments: async () => {
      const [all, outline] = await Promise.all([
        inner.listDocuments(),
        inner.collectionOutline(boundSlug),
      ]);
      const bySlug = new Map(
        outline.found ? outline.documents.map((d) => [d.slug, d]) : [],
      );
      return all
        .filter((d) => memberSet.has(d.slug))
        .map((d) => {
          const projected = bySlug.get(d.slug);
          // Both `path` and `delivery` come from the resolved-outline
          // projection. When a member is unexpectedly missing from it
          // (e.g. the bound Collection vanished mid-request, so
          // `outline` came back not-found), omit both rather than fall
          // back to `d.path` from the project-wide listDocuments —
          // that's the agent's full folder hierarchy, which the
          // preflight's fail-closed contract is supposed to keep out
          // of reach.
          return compact({
            slug: d.slug,
            title: d.title,
            docVersion: d.docVersion,
            size: d.size,
            path: projected?.path,
            delivery: projected?.delivery,
          });
        });
    },

    readCollection: async (slug) => {
      if (slug !== boundSlug) return { found: false };
      const result = await inner.readCollection(slug);
      if (!result.found) return { found: false };
      // Record the read for the freshness moment. Cross-DO call;
      // the inner method swallows failures so a momentary
      // EventLogStore blip never fails the agent's read.
      const versionMap: Record<string, number> = {};
      for (const d of result.documents) versionMap[d.slug] = d.docVersion;
      await inner.recordRead(callerRef, slug, versionMap);
      // Project to the port shape — the inner DO carries `name` /
      // `description` on found:true; the McpExecutor port does not
      // declare them, so we drop them at the wrapper edge.
      return {
        found: true as const,
        corpus: result.corpus,
        documents: result.documents.map((d) => ({
          slug: d.slug,
          docVersion: d.docVersion,
          size: d.size,
        })),
      };
    },

    // The preflight already used `inner.collectionMembers` directly on the
    // raw DO stub; the scoped wrapper only ever serves the bound slug.
    collectionMembers: async (slug) =>
      slug === boundSlug ? inner.collectionMembers(slug) : undefined,

    // Required by the McpExecutor port (handleMcp does not call it
    // directly today), but a public method on a scoped wrapper must
    // not be spoofable. Enforce closure-bound identity and scope here
    // so callers can't forge `(callerRef, collectionSlug)` against any
    // record path — only the bound caller + bound Collection are
    // acceptable. Also filter `versionMap` keys to the bound member
    // set so a caller can't smuggle a non-member slug into the durable
    // event payload (`versionCapturedAtRead`). The DO's `recordRead`
    // does no scope check; this is the only line that can.
    recordRead: (suppliedCallerRef, collectionSlug, versionMap) => {
      if (suppliedCallerRef !== callerRef) return Promise.resolve();
      if (collectionSlug !== boundSlug) return Promise.resolve();
      const filtered: Record<string, number> = {};
      for (const [slug, version] of Object.entries(versionMap)) {
        if (memberSet.has(slug)) filtered[slug] = version;
      }
      return inner.recordRead(callerRef, collectionSlug, filtered);
    },

    // The executor's only write. Same closure-bound caller identity as
    // recordRead, then the same membership gate as getDocument: a
    // non-member (or unknown) slug returns the `missing` result so the
    // handler 404s without revealing that the slug exists elsewhere, and
    // no suggestion row is ever written outside the bound Collection. The
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
      return inner.suggestEdit(
        callerRef,
        slug,
        proposedMarkdown,
        baseDocVersion,
      );
    },

    // Membership-gate. A non-member slug is indistinguishable from a
    // truly unknown document (the agent cannot probe to learn what
    // exists outside its Collection).
    getDocument: async (slug) =>
      memberSet.has(slug) ? inner.getDocument(slug) : undefined,

    // Per-slug: gate on membership; non-member returns the empty-verify
    // shape, never revealing "this slug exists somewhere." Whole-scope
    // (no slug): fan out one verify per bound-Collection member in
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
    // link projection is where reverse-leak is the most expensive: a
    // non-member link target's `documentSlug` would enumerate a slug
    // the agent cannot read. Collapse such links to the dangling /
    // external pass-through shape — same shape an unresolved relative
    // link already gets.
    collectionOutline: async (slug) => {
      if (slug !== boundSlug) return { found: false };
      const o = await inner.collectionOutline(slug);
      if (!o.found) return { found: false };
      return {
        found: true,

        collection: o.collection,
        name: o.name,
        documents: o.documents.map((d) => ({
          ...d,
          links: d.links.map((l) =>
            l.documentSlug !== null && !memberSet.has(l.documentSlug)
              ? {
                  target: l.target,
                  kind: l.kind,
                  resolvedPath: null,
                  documentSlug: null,
                  inCollection: false,
                }
              : l,
          ),
        })),
      };
    },
  };
}
