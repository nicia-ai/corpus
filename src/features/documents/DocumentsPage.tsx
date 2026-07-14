import { Link, useRouter } from "@tanstack/react-router";
import {
  Folder as FolderIcon,
  FolderInput,
  FolderPlus,
  Plus,
  Upload,
} from "lucide-react";
import { useRef, useState } from "react";

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
import type { CreateProposalItem } from "@/lib/server/suggestions";

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

  const childFolders = new Map<DropTarget, FolderRow[]>();
  for (const f of [...folders].sort((a, b) => a.position - b.position)) {
    const list = childFolders.get(f.parentSlug) ?? [];
    list.push(f);
    childFolders.set(f.parentSlug, list);
  }
  const docsByFolder = new Map<DropTarget, DocListItem[]>();
  for (const d of documents) {
    const list = docsByFolder.get(d.folderSlug) ?? [];
    list.push(d);
    docsByFolder.set(d.folderSlug, list);
  }

  const drag = useRef<Dragged | null>(null);
  // `undefined` = nothing hovered; `null` = root container; a string =
  // that folder slug.
  const [over, setOver] = useState<DropTarget | undefined>(undefined);
  const [expanded, setExpanded] = useState<ReadonlySet<FolderSlug>>(
    () => new Set(folders.map((f) => f.slug)),
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
  const visibleDocOrder = ((): DocumentSlug[] => {
    const out: DocumentSlug[] = [];
    const walk = (parent: DropTarget): void => {
      for (const f of childFolders.get(parent) ?? []) {
        if (expanded.has(f.slug)) walk(f.slug);
      }
      for (const d of docsByFolder.get(parent) ?? []) out.push(d.slug);
    };
    walk(null);
    return out;
  })();

  function selectOne(slug: DocumentSlug, range: boolean) {
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
  }

  const archive = useSubmit(async (slugs: readonly DocumentSlug[]) => {
    await archiveDocuments({ data: { projectId, slugs: [...slugs] } });
    setSelected(new Set());
    await router.invalidate();
  });

  const { error, run } = useSubmit(
    async (fn: () => Promise<{ ok: boolean; reason?: FolderOpReason }>) => {
      const r = await fn();
      if (!r.ok) throw new Error(REASON_MESSAGE[r.reason ?? "missing"]);
      await router.invalidate();
    },
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

  function toggle(slug: FolderSlug) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  function drop(target: DropTarget) {
    const d = drag.current;
    drag.current = null;
    setOver(undefined);
    if (d === null) return;
    if (d.kind === "folder") {
      if (d.slug === target) return;
      void run(() =>
        moveFolder({
          data: { projectId, slug: d.slug, newParentSlug: target },
        }),
      );
    } else {
      void run(() =>
        placeDocumentInFolder({
          data: { projectId, documentSlug: d.slug, folderSlug: target },
        }),
      );
    }
  }

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
          onToggle={() => toggle(f.slug)}
          onDragStart={() => {
            drag.current = { kind: "folder", slug: f.slug };
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (over !== f.slug) setOver(f.slug);
          }}
          onDrop={() => drop(f.slug)}
          onAddChild={() => {
            setExpanded((p) => new Set(p).add(f.slug));
            setCreatingIn(f.slug);
          }}
          onMove={() => setMove({ kind: "folder", slug: f.slug })}
          onRename={(name) =>
            run(() => renameFolder({ data: { projectId, slug: f.slug, name } }))
          }
          onDelete={() =>
            run(() => deleteFolder({ data: { projectId, slug: f.slug } }))
          }
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
                onSelect={(range) => selectOne(d.slug, range)}
                onArchive={() => void archive.run([d.slug])}
                onDragStart={() => {
                  drag.current = { kind: "doc", slug: d.slug };
                }}
                onRename={(filename) =>
                  run(() =>
                    renameFilename({
                      data: { projectId, slug: d.slug, filename },
                    }),
                  )
                }
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
                "inline-flex items-center gap-1.5",
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
                "inline-flex items-center gap-1.5",
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
                "inline-flex items-center gap-1.5",
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
            className="inline-flex items-center gap-1.5 font-medium text-slate-600 hover:text-slate-900"
          >
            <FolderInput className="size-4" />
            Move
          </button>
          <button
            type="button"
            disabled={archive.pending}
            onClick={() => void archive.run([...selected])}
            className="font-medium text-red-600 hover:underline disabled:opacity-50"
          >
            {archive.pending ? "Deleting…" : "Delete"}
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-slate-500 hover:underline"
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
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (over !== null) setOver(null);
          }}
          onDrop={() => drop(null)}
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
              drop(null);
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
              onSelect={(range) => selectOne(d.slug, range)}
              onArchive={() => void archive.run([d.slug])}
              onDragStart={() => {
                drag.current = { kind: "doc", slug: d.slug };
              }}
              onRename={(filename) =>
                run(() =>
                  renameFilename({
                    data: { projectId, slug: d.slug, filename },
                  }),
                )
              }
            />
          ))}
        </div>
      )}
    </div>
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
