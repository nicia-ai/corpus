import { Link, useRouter } from "@tanstack/react-router";
import {
  Activity,
  Folder as FolderIcon,
  FolderInput,
  FolderPlus,
  Pencil,
  Plug,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { DeleteCorpusDialog } from "@/components/corpus/DeleteCorpusDialog";
import { DocRow } from "@/components/documents/DocRow";
import { FolderHeader } from "@/components/documents/FolderHeader";
import { MoveDialog } from "@/components/documents/MoveDialog";
import { NewFolder } from "@/components/documents/NewFolder";
import { BackLink } from "@/components/ui/BackLink";
import { Button, buttonStyles } from "@/components/ui/Button";
import { listSurface } from "@/components/ui/Surface";
import { showToast } from "@/components/ui/Toast";
import type { DocumentSlug, FolderSlug, ProjectId } from "@/ids";
import { cn } from "@/lib/cn";
import { useSubmit } from "@/lib/forms";
import { connectThisCorpus } from "@/lib/server/connections";
import type { CorpusListItem } from "@/lib/server/corpora";
import {
  archiveDocuments,
  renameFilename,
  type DocListItem,
} from "@/lib/server/documents";
import {
  createFolder,
  deleteFolder,
  moveDocument,
  moveDocuments,
  moveFolder,
  renameFolder,
  type FolderRow,
} from "@/lib/server/folders";
import { type CorpusLocation, comparePaths } from "@/store/domain/corpus-drive";

import { DocumentUploader } from "../documents/DocumentUploader";

import { EditCorpusForm } from "./EditCorpusForm";

// `null` parent = the corpus root. A drag carries one item; a drop targets
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

// One corpus as a drive: its folders and pages, every path relative to the
// corpus root. The hidden root folder never appears — "Top level" is it.
export function CorpusPage({
  projectId,
  corpus,
  corpora,
  documents,
  folders,
  allFolders,
  isOwner,
  onDeleted,
}: Readonly<{
  projectId: ProjectId;
  corpus: CorpusListItem;
  corpora: readonly CorpusListItem[];
  // This corpus's pages and folders only.
  documents: readonly DocListItem[];
  folders: readonly FolderRow[];
  // Every folder in the project, for the move dialog's other corpora.
  allFolders: readonly FolderRow[];
  isOwner: boolean;
  onDeleted: () => void;
}>): React.ReactElement {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const here = useCallback(
    (folderSlug: DropTarget): CorpusLocation => ({
      corpusSlug: corpus.slug,
      folderSlug,
    }),
    [corpus.slug],
  );

  const { childFolders, docsByFolder } = useMemo(() => {
    const nextFolders = new Map<DropTarget, FolderRow[]>();
    for (const folder of [...folders].sort((a, b) =>
      comparePaths(a.name, b.name),
    )) {
      const list = nextFolders.get(folder.parentSlug) ?? [];
      list.push(folder);
      nextFolders.set(folder.parentSlug, list);
    }
    const nextDocs = new Map<DropTarget, DocListItem[]>();
    for (const document of [...documents].sort((a, b) =>
      comparePaths(a.path, b.path),
    )) {
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

  // Commit a pick from the move dialog: bulk-move the selection
  // (best-effort, reporting any name clashes) or move the one folder —
  // within this corpus or into another.
  const doMove = useSubmit(async (destination: CorpusLocation) => {
    const m = move;
    setMove(undefined);
    if (m === undefined) return;
    if (m.kind === "folder") {
      if (m.slug === destination.folderSlug) return;
      const r = await moveFolder({
        data: { projectId, slug: m.slug, destination },
      });
      if (!r.ok) throw new Error(REASON_MESSAGE[r.reason]);
    } else {
      const r = await moveDocuments({
        data: { projectId, slugs: [...selected], destination },
      });
      setSelected(new Set());
      const target = corpora.find((c) => c.slug === destination.corpusSlug);
      const where =
        target === undefined
          ? ""
          : ` to ${target.name} — ${target.served ? "shared with agents" : "not shared with agents"}`;
      showToast(
        r.failed > 0
          ? `Moved ${String(r.moved)}${where} · ${String(r.failed)} couldn’t move (name clash)`
          : `Moved ${String(r.moved)} document${r.moved === 1 ? "" : "s"}${where}`,
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
  const onFolderAddDocument = useCallback(
    (slug: FolderSlug): void => {
      void router.navigate({
        to: "/p/$projectId/documents/new",
        params: { projectId },
        search: { corpus: corpus.slug, folder: slug },
      });
    },
    [projectId, router, corpus.slug],
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
            data: { projectId, slug: item.slug, destination: here(target) },
          }),
        );
      } else {
        void run(() =>
          moveDocument({
            data: {
              projectId,
              documentSlug: item.slug,
              destination: here(target),
            },
          }),
        );
      }
    },
    [projectId, run, here],
  );

  function createFolderAt(parentSlug: DropTarget) {
    return async (name: string) => {
      await run(() =>
        createFolder({
          data: { projectId, name, location: here(parentSlug) },
        }),
      );
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
          onAddDocument={onFolderAddDocument}
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

  // "Connect this corpus": reuse-or-create the canonical Connection for this
  // corpus, then take the owner to the setup page. Owner-only (the server fn
  // enforces it); Drafts is never served, so it has no Connect.
  const connect = useSubmit(async () => {
    await connectThisCorpus({
      data: { projectId, corpusSlug: corpus.slug },
    });
    await router.navigate({
      to: "/p/$projectId/connectors/mcp/setup",
      params: { projectId },
      search: { corpus: corpus.slug },
    });
  });

  if (editing) {
    return (
      <div className="mx-auto max-w-2xl">
        <BackLink
          to="/p/$projectId/documents"
          projectId={projectId}
          label="Documents"
        />
        <EditCorpusForm
          slug={corpus.slug}
          projectId={projectId}
          initialName={corpus.name}
          initialDescription={corpus.description ?? ""}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void router.invalidate();
          }}
        />
      </div>
    );
  }

  return (
    <div className="pb-12">
      <BackLink
        to="/p/$projectId/documents"
        projectId={projectId}
        label="Documents"
      />
      <header className="mt-2 mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold">{corpus.name}</h1>
          <p className="mt-0.5 max-w-prose text-base text-slate-600">
            {corpus.served
              ? (corpus.description ??
                "A folder of markdown that connected agents can read.")
              : "Drafts — pages here are not shared with agents. Move a page into a corpus to publish it."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
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
            search={{ corpus: corpus.slug }}
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
            search={{ corpus: corpus.slug }}
            className={buttonStyles(
              "primary",
              "inline-flex items-center gap-1.5!",
            )}
          >
            <Plus className="size-4" />
            Document
          </Link>
          {corpus.served && isOwner && (
            <Button
              variant="secondary"
              onClick={() => void connect.run()}
              disabled={connect.pending}
              className="inline-flex items-center gap-1.5!"
            >
              <Plug className="size-4" />
              {connect.pending ? "Connecting…" : "Connect"}
            </Button>
          )}
          {corpus.served && (
            <Link
              to="/p/$projectId/corpora/$slug/activity"
              params={{ projectId, slug: corpus.slug }}
              className={buttonStyles(
                "secondary",
                "inline-flex items-center gap-1.5!",
              )}
            >
              <Activity className="size-4" />
              Activity
            </Link>
          )}
          {corpus.served && (
            <Button
              variant="secondary"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1.5!"
            >
              <Pencil className="size-4" />
              Edit
            </Button>
          )}
          {corpus.served && isOwner && (
            <Button
              variant="danger"
              onClick={() => setDeleting(true)}
              className="inline-flex items-center gap-1.5!"
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          )}
        </div>
      </header>
      {isOwner && connect.error !== undefined && (
        <p className="mb-3 text-base text-red-600">{connect.error}</p>
      )}

      {deleting && (
        <DeleteCorpusDialog
          projectId={projectId}
          corpus={corpus}
          onClose={() => setDeleting(false)}
          onDeleted={(outcome) => {
            setDeleting(false);
            showToast(
              outcome.archived > 0
                ? `Corpus deleted — ${String(outcome.archived)} page${outcome.archived === 1 ? "" : "s"} archived`
                : outcome.moved > 0
                  ? `Corpus deleted — ${String(outcome.moved)} page${outcome.moved === 1 ? "" : "s"} moved to Drafts`
                  : "Corpus deleted",
            );
            onDeleted();
          }}
        />
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
          corpora={corpora}
          folders={allFolders}
          disabledSubtree={move.kind === "folder" ? move.slug : undefined}
          title={
            move.kind === "folder"
              ? "Move folder to…"
              : `Move ${String(selected.size)} document${selected.size === 1 ? "" : "s"} to…`
          }
          onPick={(destination) => void doMove.run(destination)}
          onClose={() => setMove(undefined)}
        />
      )}

      {empty ? (
        <div className="mx-auto max-w-2xl">
          <h2 className="text-xl font-semibold text-slate-900">
            Nothing here yet
          </h2>
          <p className="mt-1 mb-4 text-base text-slate-500">
            Drag markdown here or pick files — they land at the top level of
            this corpus.
          </p>
          <DocumentUploader
            projectId={projectId}
            corpora={corpora}
            folders={allFolders}
            documents={documents}
            initialCorpusSlug={corpus.slug}
          />
        </div>
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
