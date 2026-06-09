import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import { EmptyState } from "@/components/ui/Surface";
import type { DocumentSlug, FolderSlug } from "@/ids";
import { useSubmit } from "@/lib/forms";
import type { DocListItem } from "@/lib/server/documents";
import type { FolderRow } from "@/lib/server/folders";
import { treeIndent } from "@/lib/tree";
import { pluralize } from "@/util";

import { AddAction } from "./DeliveryControls";
import { DocLine, docMeta, FolderLine } from "./DocLine";

// One corpus browser — the single surface for putting things in a
// collection. The same folder tree as the Documents page; from any row
// you add that one document, or add the whole folder (so future
// documents in it join automatically). One verb everywhere ("Add" /
// "Added"), no add-vs-link split. Things already in the collection stay
// visible but inert so the structure reads true. A search query
// flattens the tree to matching folders + documents.
export function CorpusBrowser({
  documents,
  folders,
  memberSlugs,
  linkedSlugs,
  addDocument,
  addFolder,
  onDone,
}: Readonly<{
  documents: readonly DocListItem[];
  folders: readonly FolderRow[];
  memberSlugs: ReadonlySet<DocumentSlug>;
  linkedSlugs: ReadonlySet<FolderSlug>;
  addDocument: (slug: DocumentSlug) => Promise<{ ok: boolean }>;
  addFolder: (slug: FolderSlug) => Promise<{ ok: boolean }>;
  onDone: () => void;
}>): React.ReactElement {
  const [q, setQ] = useState("");
  const { pending, error, run } = useSubmit(
    async (fn: () => Promise<{ ok: boolean }>) => {
      const r = await fn();
      if (!r.ok) throw new Error("That didn’t take — please retry.");
      onDone();
    },
  );

  const childFolders = useMemo(() => {
    const m = new Map<FolderSlug | null, FolderRow[]>();
    for (const f of [...folders].sort((a, b) => a.position - b.position)) {
      const list = m.get(f.parentSlug) ?? [];
      list.push(f);
      m.set(f.parentSlug, list);
    }
    return m;
  }, [folders]);

  const docsByFolder = useMemo(() => {
    const m = new Map<FolderSlug | null, DocListItem[]>();
    for (const d of documents) {
      const list = m.get(d.folderSlug) ?? [];
      list.push(d);
      m.set(d.folderSlug, list);
    }
    for (const list of m.values())
      list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return m;
  }, [documents]);

  const folderName = useMemo(() => {
    const m = new Map(folders.map((f) => [f.slug, f.name]));
    return (slug: FolderSlug | null) =>
      slug === null ? "Project root" : (m.get(slug) ?? slug);
  }, [folders]);

  // Adding a folder pulls its whole subtree, so the row count must be
  // the subtree total — a folder with docs only in subfolders read as
  // "0 documents" before, which was wrong.
  const subtreeCount = useMemo(() => {
    const memo = new Map<FolderSlug, number>();
    const visit = (slug: FolderSlug): number => {
      const cached = memo.get(slug);
      if (cached !== undefined) return cached;
      let n = docsByFolder.get(slug)?.length ?? 0;
      for (const c of childFolders.get(slug) ?? []) n += visit(c.slug);
      memo.set(slug, n);
      return n;
    };
    for (const f of folders) visit(f.slug);
    return memo;
  }, [folders, childFolders, docsByFolder]);

  // All folders collapsed by default so a large corpus is a short list of
  // folders, not a wall of documents; root-level documents always show.
  const [expanded, setExpanded] = useState<ReadonlySet<FolderSlug>>(
    () => new Set(),
  );
  function toggle(slug: FolderSlug) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  function docRow(d: DocListItem, depth: number, showFolder: boolean) {
    return (
      <DocLine
        key={d.slug}
        style={treeIndent(depth)}
        title={d.title}
        meta={
          showFolder ? (
            <>
              {folderName(d.folderSlug)} · {docMeta(d)}
            </>
          ) : (
            docMeta(d)
          )
        }
        muted={memberSlugs.has(d.slug)}
        trailing={
          <AddAction
            added={memberSlugs.has(d.slug)}
            label={`Add document ${d.title} to this collection`}
            pending={pending}
            onAdd={() => void run(() => addDocument(d.slug))}
          />
        }
      />
    );
  }

  function folderRow(
    f: FolderRow,
    depth: number,
    open: boolean,
  ): React.ReactElement {
    return (
      <FolderLine
        name={f.name}
        count={subtreeCount.get(f.slug) ?? 0}
        open={open}
        onToggle={() => toggle(f.slug)}
        style={treeIndent(depth)}
        trailing={
          <AddAction
            added={linkedSlugs.has(f.slug)}
            label={`Add folder ${f.name} to this collection`}
            pending={pending}
            onAdd={() => void run(() => addFolder(f.slug))}
          />
        }
      />
    );
  }

  function renderFolder(f: FolderRow, depth: number): React.ReactElement {
    const open = expanded.has(f.slug);
    return (
      <div key={f.slug}>
        {folderRow(f, depth, open)}
        {open && (
          <>
            {(childFolders.get(f.slug) ?? []).map((sf) =>
              renderFolder(sf, depth + 1),
            )}
            {(docsByFolder.get(f.slug) ?? []).map((d) =>
              docRow(d, depth + 1, false),
            )}
          </>
        )}
      </div>
    );
  }

  if (folders.length === 0 && documents.length === 0)
    return <EmptyState>No documents or folders to add yet.</EmptyState>;

  const needle = q.trim().toLowerCase();
  const folderHits =
    needle === ""
      ? []
      : [...folders]
          .filter((f) => f.name.toLowerCase().includes(needle))
          .sort((a, b) => a.name.localeCompare(b.name));
  const docHits =
    needle === ""
      ? []
      : documents
          .filter(
            (d) =>
              d.title.toLowerCase().includes(needle) ||
              d.filename.toLowerCase().includes(needle) ||
              d.path.toLowerCase().includes(needle),
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-3 py-2">
        <Search className="size-4 shrink-0 text-slate-400" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${pluralize(documents.length, "document")} and folders…`}
          aria-label="Search documents and folders to add"
          className="w-full bg-transparent text-base outline-none placeholder:text-slate-400"
        />
      </div>
      {error && (
        <p className="border-b border-slate-200 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      {needle !== "" ? (
        <div className="max-h-112 divide-y divide-slate-200 overflow-y-auto">
          {folderHits.length === 0 && docHits.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-slate-500">
              Nothing matches “{q}”.
            </p>
          ) : (
            <>
              {folderHits.map((f) => (
                <FolderLine
                  key={f.slug}
                  name={f.name}
                  count={subtreeCount.get(f.slug) ?? 0}
                  trailing={
                    <AddAction
                      added={linkedSlugs.has(f.slug)}
                      label={`Add folder ${f.name} to this collection`}
                      pending={pending}
                      onAdd={() => void run(() => addFolder(f.slug))}
                    />
                  }
                />
              ))}
              {docHits.map((d) => docRow(d, 0, true))}
            </>
          )}
        </div>
      ) : (
        <div className="max-h-112 divide-y divide-slate-200 overflow-y-auto">
          {(childFolders.get(null) ?? []).map((f) => renderFolder(f, 0))}
          {(docsByFolder.get(null) ?? []).map((d) => docRow(d, 0, false))}
        </div>
      )}
    </div>
  );
}
