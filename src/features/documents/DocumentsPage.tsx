import { Link, useRouter } from "@tanstack/react-router";
import {
  Folder as FolderIcon,
  FolderInput,
  FolderPlus,
  Plus,
  Search,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DocRow } from "@/components/documents/DocRow";
import { FolderHeader } from "@/components/documents/FolderHeader";
import { MoveDialog } from "@/components/documents/MoveDialog";
import { NewFolder } from "@/components/documents/NewFolder";
import { buttonStyles } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { listSurface } from "@/components/ui/Surface";
import { textLinkClass } from "@/components/ui/text-link";
import { showToast } from "@/components/ui/Toast";
import type { DocumentSlug, FolderSlug, ProjectId } from "@/ids";
import { cn } from "@/lib/cn";
import { useSubmit } from "@/lib/forms";
import type { ColListItem } from "@/lib/server/collections";
import {
  archiveDocuments,
  renameFilename,
  type DocListItem,
} from "@/lib/server/documents";
import {
  createFolder,
  deleteFolder,
  moveDocumentsToFolder,
  moveFolder,
  placeDocumentInFolder,
  renameFolder,
  type FolderRow,
} from "@/lib/server/folders";
import { searchDocuments, type SearchHit } from "@/lib/server/search";
import type { CreateProposalItem } from "@/lib/server/suggestions";
import { useCollab, type RealtimeChange } from "@/lib/use-collab";

import { DocumentUploader } from "./DocumentUploader";
import { ProposedDocuments } from "./ProposedDocuments";

// `null` parent = project root. A drag carries one item; a drop targets
// a folder slug or the root.
type Dragged =
  | Readonly<{ kind: "doc"; slug: DocumentSlug }>
  | Readonly<{ kind: "folder"; slug: FolderSlug }>;
type DropTarget = FolderSlug | null;

// The closed set of failure reasons every folder/doc placement server fn
// can return (each outcome's `reason` is a subset of this).
type FolderOpReason = "missing" | "cycle" | "segment-collision";

const REASON_MESSAGE: Readonly<Record<FolderOpReason, string>> = {
  missing: "That no longer exists — refreshing.",
  cycle: "Can’t move a folder into its own subtree.",
  "segment-collision": "A file or folder with that name already exists there.",
};

// Minimum trimmed query length before a content search fires. Mirrors the
// DO-side floor (SEARCH_MIN_QUERY); the server re-enforces it authoritatively.
const MIN_QUERY_CHARS = 2;

export function DocumentsPage({
  projectId,
  documents,
  folders,
  collections,
  proposals,
}: Readonly<{
  projectId: ProjectId;
  documents: readonly DocListItem[];
  folders: readonly FolderRow[];
  collections: readonly ColListItem[];
  proposals: readonly CreateProposalItem[];
}>): React.ReactElement {
  const router = useRouter();
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

  const { childFolders, docsByFolder } = useMemo(() => {
    const nextFolders = new Map<DropTarget, FolderRow[]>();
    for (const folder of [...folders].sort((a, b) => a.position - b.position)) {
      const list = nextFolders.get(folder.parentSlug) ?? [];
      list.push(folder);
      nextFolders.set(folder.parentSlug, list);
    }
    const nextDocs = new Map<DropTarget, DocListItem[]>();
    for (const document of documents) {
      const list = nextDocs.get(document.folderSlug) ?? [];
      list.push(document);
      nextDocs.set(document.folderSlug, list);
    }
    return { childFolders: nextFolders, docsByFolder: nextDocs };
  }, [documents, folders]);

  const drag = useRef<Dragged | null>(null);
  // `undefined` = nothing hovered; `null` = root container; a string =
  // that folder slug.
  const [over, setOver] = useState<DropTarget | undefined>(undefined);
  const [expanded, setExpanded] = useState<ReadonlySet<FolderSlug>>(
    () =>
      new Set(
        folders
          .filter((folder) => folder.parentSlug === null)
          .map((folder) => folder.slug),
      ),
  );
  const [creatingIn, setCreatingIn] = useState<DropTarget | undefined>();
  const [selected, setSelected] = useState<ReadonlySet<DocumentSlug>>(
    () => new Set(),
  );
  // The pivot for shift-click range selection (the last plainly-clicked
  // row); a range extends from here to the shift-clicked row.
  const anchor = useRef<DocumentSlug | null>(null);
  // Which folder picker (if any) is open: the multi-doc move from the
  // selection bar, or a single folder's move from its row.
  const [move, setMove] =
    useState<
      Readonly<{ kind: "docs" } | { kind: "folder"; slug: FolderSlug }>
    >();

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

  // Document slugs in visible top-to-bottom order (collapsed folders
  // contribute nothing) — the index space shift-click ranges over.
  // Mirrors the render: a folder's subfolders precede its own documents.
  const visibleDocOrder = useMemo((): DocumentSlug[] => {
    const out: DocumentSlug[] = [];
    const walk = (parent: DropTarget): void => {
      for (const f of childFolders.get(parent) ?? []) {
        if (expanded.has(f.slug)) walk(f.slug);
      }
      for (const d of docsByFolder.get(parent) ?? []) out.push(d.slug);
    };
    walk(null);
    return out;
  }, [childFolders, docsByFolder, expanded]);

  const selectOne = useCallback(
    (slug: DocumentSlug, range: boolean): void => {
      if (range && anchor.current !== null) {
        const i = visibleDocOrder.indexOf(anchor.current);
        const j = visibleDocOrder.indexOf(slug);
        if (i !== -1 && j !== -1) {
          const [lo, hi] = i < j ? [i, j] : [j, i];
          setSelected((prev) => {
            const next = new Set(prev);
            for (const s of visibleDocOrder.slice(lo, hi + 1)) next.add(s);
            return next;
          });
          return;
        }
      }
      anchor.current = slug;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(slug)) next.delete(slug);
        else next.add(slug);
        return next;
      });
    },
    [visibleDocOrder],
  );

  const archive = useSubmit(async (slugs: readonly DocumentSlug[]) => {
    await archiveDocuments({ data: { projectId, slugs: [...slugs] } });
    setSelected(new Set());
    await router.invalidate();
  });
  const archiveRun = archive.run;

  const { error, run } = useSubmit(
    async (fn: () => Promise<{ ok: boolean; reason?: FolderOpReason }>) => {
      const r = await fn();
      if (!r.ok) throw new Error(REASON_MESSAGE[r.reason ?? "missing"]);
      await router.invalidate();
    },
  );

  const onDocArchive = useCallback(
    (slug: DocumentSlug): void => {
      void archiveRun([slug]);
    },
    [archiveRun],
  );
  const onDocDragStart = useCallback((slug: DocumentSlug): void => {
    drag.current = { kind: "doc", slug };
  }, []);
  const onDocRename = useCallback(
    (slug: DocumentSlug, filename: string): Promise<void> =>
      run(() => renameFilename({ data: { projectId, slug, filename } })),
    [projectId, run],
  );

  // Commit a folder pick from the move dialog: bulk-move the selection
  // (best-effort, reporting any name clashes) or move the one folder.
  const doMove = useSubmit(async (target: DropTarget) => {
    const m = move;
    setMove(undefined);
    if (m === undefined) return;
    if (m.kind === "folder") {
      if (m.slug === target) return;
      const r = await moveFolder({
        data: { projectId, slug: m.slug, newParentSlug: target },
      });
      if (!r.ok) throw new Error(REASON_MESSAGE[r.reason]);
    } else {
      const r = await moveDocumentsToFolder({
        data: { projectId, slugs: [...selected], folderSlug: target },
      });
      setSelected(new Set());
      showToast(
        r.failed > 0
          ? `Moved ${String(r.moved)} · ${String(r.failed)} couldn’t move (name clash)`
          : `Moved ${String(r.moved)} document${r.moved === 1 ? "" : "s"}`,
      );
    }
    await router.invalidate();
  });

  const onFolderToggle = useCallback((slug: FolderSlug): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);
  const onFolderDragStart = useCallback((slug: FolderSlug): void => {
    drag.current = { kind: "folder", slug };
  }, []);
  const onFolderDragOver = useCallback(
    (slug: FolderSlug, event: React.DragEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      setOver((current) => (current === slug ? current : slug));
    },
    [],
  );
  const onFolderAddChild = useCallback((slug: FolderSlug): void => {
    setExpanded((current) => new Set(current).add(slug));
    setCreatingIn(slug);
  }, []);
  const onFolderMove = useCallback((slug: FolderSlug): void => {
    setMove({ kind: "folder", slug });
  }, []);
  const onFolderRename = useCallback(
    (slug: FolderSlug, name: string): Promise<void> =>
      run(() => renameFolder({ data: { projectId, slug, name } })),
    [projectId, run],
  );
  const onFolderDelete = useCallback(
    (slug: FolderSlug): Promise<void> =>
      run(() => deleteFolder({ data: { projectId, slug } })),
    [projectId, run],
  );

  const commitDrop = useCallback(
    (target: DropTarget): void => {
      const item = drag.current;
      drag.current = null;
      setOver(undefined);
      if (item === null) return;
      if (item.kind === "folder") {
        if (item.slug === target) return;
        void run(() =>
          moveFolder({
            data: { projectId, slug: item.slug, newParentSlug: target },
          }),
        );
      } else {
        void run(() =>
          placeDocumentInFolder({
            data: {
              projectId,
              documentSlug: item.slug,
              folderSlug: target,
            },
          }),
        );
      }
    },
    [projectId, run],
  );

  function createFolderAt(parentSlug: DropTarget) {
    return async (name: string) => {
      await run(() => createFolder({ data: { projectId, name, parentSlug } }));
      setCreatingIn(undefined);
    };
  }

  function renderFolder(f: FolderRow, depth: number): React.ReactElement {
    const isOpen = expanded.has(f.slug);
    const subFolders = childFolders.get(f.slug) ?? [];
    const subDocs = docsByFolder.get(f.slug) ?? [];
    return (
      <div key={f.slug}>
        <FolderHeader
          folder={f}
          depth={depth}
          open={isOpen}
          highlighted={over === f.slug}
          onToggle={onFolderToggle}
          onDragStart={onFolderDragStart}
          onDragOver={onFolderDragOver}
          onDrop={commitDrop}
          onAddChild={onFolderAddChild}
          onMove={onFolderMove}
          onRename={onFolderRename}
          onDelete={onFolderDelete}
        />
        {isOpen && (
          <>
            {creatingIn === f.slug && (
              <NewFolder
                depth={depth + 1}
                onCancel={() => setCreatingIn(undefined)}
                onCreate={createFolderAt(f.slug)}
              />
            )}
            {subFolders.map((sf) => renderFolder(sf, depth + 1))}
            {subDocs.map((d) => (
              <DocRow
                key={d.slug}
                doc={d}
                projectId={projectId}
                depth={depth + 1}
                selected={selected.has(d.slug)}
                onSelect={selectOne}
                onArchive={onDocArchive}
                onDragStart={onDocDragStart}
                onRename={onDocRename}
              />
            ))}
          </>
        )}
      </div>
    );
  }

  const rootFolders = childFolders.get(null) ?? [];
  const rootDocs = docsByFolder.get(null) ?? [];
  const empty = folders.length === 0 && documents.length === 0;

  return (
    <div>
      <PageHeader
        title="Documents"
        actions={
          <>
            <button
              type="button"
              onClick={() => setCreatingIn(null)}
              className={buttonStyles(
                "secondary",
                "inline-flex items-center gap-1.5!",
              )}
            >
              <FolderPlus className="size-4" />
              Folder
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
          </>
        }
      />

      {proposals.length > 0 && (
        <div className="mb-6">
          <ProposedDocuments projectId={projectId} proposals={proposals} />
        </div>
      )}

      {!empty && (
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

      {error && <p className="mb-3 text-base text-red-600">{error}</p>}
      {/* Page-level (not inside the selection bar) so a per-row delete
          failure with nothing selected is still visible. */}
      {archive.error && (
        <p className="mb-3 text-base text-red-600">{archive.error}</p>
      )}
      {doMove.error && (
        <p className="mb-3 text-base text-red-600">{doMove.error}</p>
      )}

      {selected.size > 0 && (
        <div className="mb-3 flex items-center gap-4 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
          <span className="font-medium text-slate-700">
            {selected.size} selected
          </span>
          <button
            type="button"
            onClick={() => setMove({ kind: "docs" })}
            className="inline-flex min-h-11 items-center gap-1.5 font-medium text-slate-600 hover:text-slate-900"
          >
            <FolderInput className="size-4" />
            Move
          </button>
          <button
            type="button"
            disabled={archive.pending}
            onClick={() => void archive.run([...selected])}
            className="min-h-11 font-medium text-red-600 hover:underline disabled:opacity-50"
          >
            {archive.pending ? "Deleting…" : "Delete"}
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="min-h-11 text-slate-500 hover:underline"
          >
            Clear
          </button>
        </div>
      )}

      {move !== undefined && (
        <MoveDialog
          folders={folders}
          childFolders={childFolders}
          disabledSubtree={move.kind === "folder" ? move.slug : undefined}
          title={
            move.kind === "folder"
              ? "Move folder to…"
              : `Move ${String(selected.size)} document${selected.size === 1 ? "" : "s"} to…`
          }
          onPick={(target) => void doMove.run(target)}
          onClose={() => setMove(undefined)}
        />
      )}

      {empty ? (
        <EmptyDocuments
          projectId={projectId}
          collections={collections}
          folders={folders}
          documents={documents}
        />
      ) : searchActive ? (
        <SearchResults
          projectId={projectId}
          hits={hits}
          error={searchError}
          onRetry={retrySearch}
          query={query.trim()}
        />
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (over !== null) setOver(null);
          }}
          onDrop={() => commitDrop(null)}
          className={listSurface(cn("divide-y divide-slate-200"))}
        >
          <div
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (over !== null) setOver(null);
            }}
            onDrop={(e) => {
              e.stopPropagation();
              commitDrop(null);
            }}
            className={cn(
              "flex items-center gap-2 px-3 py-2 text-sm",
              over === null
                ? "bg-blue-50 font-medium text-blue-700"
                : "text-slate-400",
            )}
          >
            <FolderIcon className="size-4 shrink-0" aria-hidden />
            Top level
            <span className="font-normal text-slate-400">
              — drag a document or folder here to move it out
            </span>
          </div>
          {creatingIn === null && (
            <NewFolder
              depth={0}
              onCancel={() => setCreatingIn(undefined)}
              onCreate={createFolderAt(null)}
            />
          )}
          {rootFolders.map((f) => renderFolder(f, 0))}
          {rootDocs.map((d) => (
            <DocRow
              key={d.slug}
              doc={d}
              projectId={projectId}
              depth={0}
              selected={selected.has(d.slug)}
              onSelect={selectOne}
              onArchive={onDocArchive}
              onDragStart={onDocDragStart}
              onRename={onDocRename}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Flat hit list shown while a search query is active; clearing the box
// (or Escape) restores the folder tree. Rows navigate like DocRow titles.
function SearchResults({
  projectId,
  hits,
  error,
  onRetry,
  query,
}: Readonly<{
  projectId: ProjectId;
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
              {h.path}
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
// is already on Documents.
function EmptyDocuments({
  projectId,
  collections,
  folders,
  documents,
}: Readonly<{
  projectId: ProjectId;
  collections: readonly ColListItem[];
  folders: readonly FolderRow[];
  documents: readonly DocListItem[];
}>): React.ReactElement {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-slate-900">
          Add your first document
        </h2>
        <p className="mt-1 text-base text-slate-500">
          Drag a folder of markdown here, or pick files — then group them into a
          collection to share with agents.
        </p>
      </div>
      <DocumentUploader
        projectId={projectId}
        collections={collections}
        folders={folders}
        documents={documents}
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
