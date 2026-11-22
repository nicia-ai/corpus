import { Link, useRouter } from "@tanstack/react-router";
import { Library, Plus, Search, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { NewIntakeDialog } from "@/components/document/NewIntakeDialog";
import { buttonStyles } from "@/components/ui/Button";
import { RelativeTime } from "@/components/ui/DateTime";
import { PageHeader } from "@/components/ui/PageHeader";
import { listSurface } from "@/components/ui/Surface";
import { textLinkClass } from "@/components/ui/text-link";
import type { CorpusSlug, ProjectId } from "@/ids";
import { cn } from "@/lib/cn";
import type { CorpusListItem } from "@/lib/server/corpora";
import type { DocListItem, RecentDocument } from "@/lib/server/documents";
import type { FolderRow } from "@/lib/server/folders";
import { searchDocuments, type SearchHit } from "@/lib/server/search";
import type { CreateProposalItem } from "@/lib/server/suggestions";
import { useCollab, type RealtimeChange } from "@/lib/use-collab";

import { CreateCorpusForm } from "../corpora/CreateCorpusForm";

import { DocumentUploader } from "./DocumentUploader";
import { ProposedDocuments } from "./ProposedDocuments";

// Minimum trimmed query length before a content search fires. Mirrors the
// DO-side floor (SEARCH_MIN_QUERY); the server re-enforces it authoritatively.
const MIN_QUERY_CHARS = 2;

function corpusNameOf(
  corpora: readonly CorpusListItem[],
  slug: CorpusSlug,
): string {
  return corpora.find((c) => c.slug === slug)?.name ?? slug;
}

// The project's entry: its corpora. Each opens onto its own tree of
// folders and pages; Drafts — the unpublished space — is listed in plain
// words as not shared with agents.
export function DocumentsPage({
  projectId,
  corpora,
  recentDocuments,
  proposals,
  uploadContext,
  isOwner,
}: Readonly<{
  projectId: ProjectId;
  corpora: readonly CorpusListItem[];
  recentDocuments: readonly RecentDocument[];
  proposals: readonly CreateProposalItem[];
  // Only loaded when no page exists yet, for the first-upload card.
  uploadContext:
    | Readonly<{
        documents: readonly DocListItem[];
        folders: readonly FolderRow[];
      }>
    | undefined;
  isOwner: boolean;
}>): React.ReactElement {
  const router = useRouter();
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const refreshProposalReview = useCallback(
    (change: RealtimeChange | undefined): void => {
      if (
        change?.action === "suggestion.created" ||
        change?.action === "suggestion.replied" ||
        change?.action === "suggestion.applied" ||
        change?.action === "suggestion.rejected"
      ) {
        void router.invalidate({
          filter: (match) => match.routeId === "/p/$projectId/documents/",
        });
      }
    },
    [router],
  );
  // The documents index is the canonical review surface for proposed NEW
  // documents. Subscribe to project nudges (with no real document selected)
  // so reviewer/agent messages and terminal decisions appear without a
  // manual reload. This socket carries only invalidation signals, never data.
  useCollab(projectId, "", refreshProposalReview);

  // Content search. Event-driven (input -> debounce -> server fn), not an
  // effect: the query is user input, not route data. The sequence counter
  // drops out-of-order responses; bumping it on clear also invalidates any
  // in-flight call so a stale result can't repopulate a cleared box.
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<readonly SearchHit[]>();
  const [searchError, setSearchError] = useState(false);
  const searchSeq = useRef(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchActive = query.trim().length >= MIN_QUERY_CHARS;

  useEffect(
    () => () => {
      if (searchTimer.current !== undefined) {
        clearTimeout(searchTimer.current);
      }
      searchSeq.current += 1;
    },
    [],
  );

  function runSearch(q: string, seq: number): void {
    searchDocuments({ data: { projectId, query: q } })
      .then((res) => {
        if (seq !== searchSeq.current) return;
        setHits(res);
      })
      .catch(() => {
        if (seq !== searchSeq.current) return;
        // A failed request is distinct from an empty result — surface it so
        // the user can retry rather than read an outage as "no matches".
        setSearchError(true);
      });
  }

  function onQueryChange(next: string): void {
    setQuery(next);
    if (searchTimer.current !== undefined) clearTimeout(searchTimer.current);
    const q = next.trim();
    searchSeq.current += 1;
    setSearchError(false);
    // Drop the previous query's hits immediately so stale (clickable) results
    // never linger through the debounce + request window; the searching state
    // shows until the new results land.
    setHits(undefined);
    if (q.length < MIN_QUERY_CHARS) return;
    const seq = searchSeq.current;
    searchTimer.current = setTimeout(() => runSearch(q, seq), 250);
  }

  function retrySearch(): void {
    const q = query.trim();
    if (q.length < MIN_QUERY_CHARS) return;
    if (searchTimer.current !== undefined) clearTimeout(searchTimer.current);
    searchSeq.current += 1;
    setSearchError(false);
    setHits(undefined);
    runSearch(q, searchSeq.current);
  }

  // Named corpora first, in name order; Drafts last.
  const ordered = [...corpora].sort(
    (a, b) =>
      Number(!a.served) - Number(!b.served) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const totalPages = corpora.reduce((sum, c) => sum + c.documentCount, 0);

  return (
    <div>
      {intakeOpen && (
        <NewIntakeDialog
          projectId={projectId}
          onClose={() => setIntakeOpen(false)}
        />
      )}
      <PageHeader
        title="Corpora"
        actions={
          <>
            <button
              type="button"
              onClick={() => setCreating(true)}
              aria-label="New corpus"
              className={buttonStyles(
                "secondary",
                "inline-flex items-center gap-1.5!",
              )}
            >
              <Library className="size-4" />
              Corpus
            </button>
            <Link
              to="/p/$projectId/import"
              params={{ projectId }}
              className={buttonStyles(
                "secondary",
                "inline-flex items-center gap-1.5!",
              )}
            >
              <Upload className="size-4" />
              Upload
            </Link>
            <Link
              to="/p/$projectId/documents/new"
              params={{ projectId }}
              className={buttonStyles(
                "primary",
                "inline-flex items-center gap-1.5!",
              )}
            >
              <Plus className="size-4" />
              Document
            </Link>
            {isOwner && (
              <button
                type="button"
                onClick={() => setIntakeOpen(true)}
                className={buttonStyles(
                  "secondary",
                  "inline-flex items-center gap-1.5!",
                )}
              >
                Intake
              </button>
            )}
          </>
        }
      />

      {creating && (
        <CreateCorpusForm
          projectId={projectId}
          onCancel={() => setCreating(false)}
        />
      )}

      {proposals.length > 0 && (
        <div className="mb-6">
          <ProposedDocuments projectId={projectId} proposals={proposals} />
        </div>
      )}

      {recentDocuments.length > 0 && !searchActive && (
        <RecentDocuments projectId={projectId} documents={recentDocuments} />
      )}

      {totalPages > 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2">
          <Search className="size-4 shrink-0 text-slate-400" aria-hidden />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onQueryChange("");
            }}
            placeholder="Search documents…"
            aria-label="Search documents"
            className="w-full bg-transparent text-base outline-none placeholder:text-slate-400"
          />
          {query !== "" && (
            <button
              type="button"
              onClick={() => onQueryChange("")}
              className="min-h-11 text-sm font-medium text-slate-500 hover:text-slate-900"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {searchActive ? (
        <SearchResults
          projectId={projectId}
          corpora={corpora}
          hits={hits}
          error={searchError}
          onRetry={retrySearch}
          query={query.trim()}
        />
      ) : (
        <>
          <h2 className="mb-3 text-xl font-semibold text-slate-900">Corpora</h2>
          <ul className={listSurface("divide-y divide-slate-200")}>
            {ordered.map((c) => (
              <li key={c.slug}>
                <Link
                  to="/p/$projectId/corpora/$slug"
                  params={{ projectId, slug: c.slug }}
                  className="flex min-h-14 items-center gap-4 px-4 py-3 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-600"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-medium text-slate-900">
                      {c.name}
                    </div>
                    <div className="mt-0.5 truncate text-sm text-slate-500">
                      {c.served
                        ? (c.description ?? "Shared with connected agents")
                        : "Not shared with agents — move pages into a corpus to publish them"}
                    </div>
                  </div>
                  <span className="shrink-0 text-sm tabular-nums text-slate-500">
                    {c.documentCount} page{c.documentCount === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {uploadContext !== undefined && totalPages === 0 && (
            <EmptyDocuments
              projectId={projectId}
              corpora={corpora}
              context={uploadContext}
            />
          )}
        </>
      )}
    </div>
  );
}

function RecentDocuments({
  projectId,
  documents,
}: Readonly<{
  projectId: ProjectId;
  documents: readonly RecentDocument[];
}>): React.ReactElement {
  return (
    <section aria-labelledby="recent-documents-heading" className="mb-8">
      <h2
        id="recent-documents-heading"
        className="mb-3 text-xl font-semibold text-slate-900"
      >
        Recently modified
      </h2>
      <ol className={listSurface("divide-y divide-slate-200")}>
        {documents.map((document) => (
          <li key={document.slug}>
            <Link
              to="/p/$projectId/documents/$slug"
              params={{ projectId, slug: document.slug }}
              className="flex min-h-14 items-center gap-4 px-4 py-2.5 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-600"
            >
              <div className="min-w-0 flex-1">
                <span className="block truncate font-medium text-slate-900">
                  {document.title}
                </span>
              </div>
              <RelativeTime
                iso={document.updatedAt}
                className="shrink-0 text-sm tabular-nums text-slate-500"
              />
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

// Flat hit list shown while a search query is active; clearing the box
// (or Escape) restores the folder tree. Rows navigate like DocRow titles.
function SearchResults({
  projectId,
  corpora,
  hits,
  error,
  onRetry,
  query,
}: Readonly<{
  projectId: ProjectId;
  corpora: readonly CorpusListItem[];
  hits: readonly SearchHit[] | undefined;
  error: boolean;
  onRetry: () => void;
  query: string;
}>): React.ReactElement {
  if (error) {
    return (
      <p
        className="flex items-center gap-3 px-3 py-6 text-sm text-slate-500"
        aria-live="polite"
      >
        Search failed.
        <button
          type="button"
          onClick={onRetry}
          className="min-h-11 font-medium text-slate-900 hover:underline"
        >
          Retry
        </button>
      </p>
    );
  }
  // hits === undefined only while a query >= MIN_QUERY_CHARS is in flight
  // (a shorter query clears the box and hides this view entirely).
  if (hits === undefined) {
    return (
      <p className="px-3 py-6 text-sm text-slate-500" aria-live="polite">
        Searching…
      </p>
    );
  }
  if (hits.length === 0) {
    return (
      <p className="px-3 py-6 text-sm text-slate-500" aria-live="polite">
        No documents match “{query}”.
      </p>
    );
  }
  return (
    <div className={listSurface(cn("divide-y divide-slate-200"))}>
      {hits.map((h) => (
        <Link
          key={h.slug}
          to="/p/$projectId/documents/$slug"
          params={{ projectId, slug: h.slug }}
          className="block px-3 py-2.5 hover:bg-slate-50"
        >
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 truncate font-medium text-slate-900">
              {h.title}
            </span>
            <span className="min-w-0 truncate text-sm text-slate-400">
              {corpusNameOf(corpora, h.corpusSlug)} · {h.path}
            </span>
          </span>
          <SearchSnippetLine snippet={h.snippet} />
        </Link>
      ))}
    </div>
  );
}

// The FTS snippet arrives with `<mark>…</mark>` around the matched terms.
// Split on those delimiters and emphasize the matched segments with a
// neutral slate wash + weight (no new accent color). Every segment renders
// as escaped text, never HTML, so document content cannot inject markup.
function SearchSnippetLine({
  snippet,
}: Readonly<{ snippet: string }>): React.ReactElement {
  const parts = snippet.split(/<\/?mark>/);
  return (
    <p className="mt-0.5 truncate text-sm text-slate-500">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark
            key={i}
            className="rounded-sm bg-slate-200 px-0.5 font-medium text-slate-900"
          >
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </p>
  );
}

// The empty-state IS the upload flow (matches the SeedChooser pattern
// on Home). When the import lands, the route loader returns documents
// and this component unmounts — no Done card needed because the user
// is already on Corpora.
function EmptyDocuments({
  projectId,
  corpora,
  context,
}: Readonly<{
  projectId: ProjectId;
  corpora: readonly CorpusListItem[];
  context: Readonly<{
    documents: readonly DocListItem[];
    folders: readonly FolderRow[];
  }>;
}>): React.ReactElement {
  return (
    <div className="mx-auto mt-8 max-w-2xl">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-slate-900">
          Add your first document
        </h2>
        <p className="mt-1 text-base text-slate-500">
          Drag markdown here or pick files. They start in Drafts; choose a
          corpus below to publish them to agents right away.
        </p>
      </div>
      <DocumentUploader
        projectId={projectId}
        corpora={corpora}
        folders={context.folders}
        documents={context.documents}
      />
      <p className="mt-6 text-sm text-slate-500">
        Or{" "}
        <Link
          to="/p/$projectId/documents/new"
          params={{ projectId }}
          className={textLinkClass("text-sm")}
        >
          create a document
        </Link>{" "}
        from scratch.
      </p>
    </div>
  );
}
