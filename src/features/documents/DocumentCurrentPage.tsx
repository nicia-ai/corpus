import { useNavigate, useRouter } from "@tanstack/react-router";
import { lazy, Suspense, useMemo, useState } from "react";

import { ProseDiff, DiffPanel } from "@/components/diff/Diff";
import { DocHeader } from "@/components/document/DocHeader";
import { Field } from "@/components/Field";
import { Markdown } from "@/components/markdown/Markdown";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { textLinkClass } from "@/components/ui/text-link";
import { showToast } from "@/components/ui/Toast";
import type { ProjectId } from "@/ids";
import { lineDiff } from "@/lib/diff";
import { useSubmit } from "@/lib/forms";
import {
  archiveDocument,
  type DocSnapshot,
  getDocument,
  getDocuments,
  renameDocument,
  renameFilename,
  saveDocument,
} from "@/lib/server/documents";

// CodeMirror only loads when a reader first enters edit mode — it stays out
// of the read path's route chunk (the primary audience reads, not edits).
const MarkdownEditor = lazy(() =>
  import("@/components/markdown/MarkdownEditor").then((m) => ({
    default: m.MarkdownEditor,
  })),
);

const editorFallback = (
  <div className="min-h-[28rem] rounded-md border border-slate-300 bg-white" />
);

export function DocumentCurrentPage({
  doc,
  projectId,
}: Readonly<{
  doc: DocSnapshot | undefined;
  projectId: ProjectId;
}>): React.ReactElement | null {
  if (doc === undefined) return null;

  // Keyed by version: a successful save invalidates the loader, the new
  // version remounts Editor with a fresh draft — no useEffect re-seeding.
  return <Editor key={doc.docVersion} doc={doc} projectId={projectId} />;
}

function Editor({
  doc,
  projectId,
}: Readonly<{
  doc: DocSnapshot;
  projectId: ProjectId;
}>): React.ReactElement {
  const router = useRouter();
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [renaming, setRenaming] = useState(false);
  const [renamingFile, setRenamingFile] = useState(false);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [draft, setDraft] = useState(doc.markdown);
  const [broken, setBroken] = useState(0);
  // The version a save is optimistically checked against. Starts at the
  // loaded doc; after resolving a 409 without overwriting it advances to
  // the fetched head, so the next save doesn't immediately re-conflict.
  // A successful save remounts this component (version key), resetting it.
  const [base, setBase] = useState<DocSnapshot>(doc);
  const [conflict, setConflict] = useState<DocSnapshot>();

  // Slugs feed the editor's broken-link linter and matter only in edit
  // mode, so they load on first edit (not in the loader — every read view,
  // the common case, would otherwise pull the whole document list).
  const [slugs, setSlugs] = useState<readonly string[]>();
  const { run: loadSlugs } = useSubmit(async () => {
    setSlugs((await getDocuments({ data: { projectId } })).map((d) => d.slug));
  });

  function enterEdit() {
    setMode("edit");
    if (slugs === undefined) void loadSlugs();
  }
  function cancel() {
    setDraft(base.markdown);
    setTab("write");
    setMode("read");
  }

  const {
    pending,
    error,
    run: save,
  } = useSubmit(async (against: DocSnapshot, body: string) => {
    const r = await saveDocument({
      data: {
        projectId,
        slug: against.slug,
        title: against.title,
        markdown: body,
        clientVersion: against.docVersion,
      },
    });
    if (!r.ok) {
      if ("conflict" in r) {
        const theirs = await getDocument({
          data: { projectId, slug: against.slug },
        });
        if (theirs !== undefined) setConflict(theirs);
        return;
      }
      throw new Error("Save was rolled back — please retry.");
    }
    setConflict(undefined);
    showToast("Saved");
    void router.invalidate();
  });

  const {
    pending: renamePending,
    error: renameError,
    run: runRename,
  } = useSubmit(async (nextTitle: string) => {
    const t = nextTitle.trim();
    if (t === "" || t === base.title) {
      setRenaming(false);
      return;
    }
    const r = await renameDocument({
      data: { projectId, slug: base.slug, title: t },
    });
    if (!r.ok) throw new Error("Rename failed — please retry.");
    // A rename doesn't bump docVersion, so the version-key remount that
    // re-seeds after a content save never fires here. Update the local
    // head optimistically (the server accepted it); onSaved() flashes +
    // invalidates so other routes' loaders pick up the new title.
    setBase((b) => ({ ...b, title: t }));
    setRenaming(false);
    showToast("Title updated");
    void router.invalidate();
  });

  const {
    pending: filePending,
    error: fileError,
    run: runRenameFile,
  } = useSubmit(async (nextName: string) => {
    const f = nextName.trim();
    if (f === "" || f === base.filename) {
      setRenamingFile(false);
      return;
    }
    const r = await renameFilename({
      data: { projectId, slug: base.slug, filename: f },
    });
    if (!r.ok) {
      throw new Error(
        r.reason === "segment-collision"
          ? "A file or folder with that name already exists in this folder."
          : "Rename failed — please retry.",
      );
    }
    // Filename is head metadata — no docVersion bump, so (like the
    // title rename) update the local head optimistically and invalidate
    // so other routes pick up the new path / resolved links.
    setBase((b) => ({ ...b, filename: f }));
    setRenamingFile(false);
    showToast("File renamed");
    void router.invalidate();
  });

  const navigate = useNavigate();
  const {
    pending: deletePending,
    error: deleteError,
    run: runDelete,
  } = useSubmit(async () => {
    const ok = await confirmDialog({
      title: `Delete “${base.title}”?`,
      body: "It is removed from all collections and hidden. History is kept.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    const r = await archiveDocument({
      data: { projectId, slug: base.slug },
    });
    if (!r.ok) throw new Error("Delete failed — please retry.");
    // Archived: gone from the list + MCP. Leave the now-dead detail page.
    await navigate({ to: "/p/$projectId/documents", params: { projectId } });
  });

  const conflictDiff = useMemo(
    () => (conflict ? lineDiff(conflict.markdown, draft) : []),
    [conflict, draft],
  );

  if (conflict !== undefined) {
    return (
      <div>
        <h1 className="mb-1 text-2xl font-semibold">
          Someone else edited this
        </h1>
        <p className="mb-4 text-base text-slate-500">
          The document changed while you were editing. Choose how to resolve —
          nothing is lost.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <DiffPanel title={`Their version (v${conflict.docVersion})`}>
            {conflict.markdown}
          </DiffPanel>
          <DiffPanel title="Your version">{draft}</DiffPanel>
        </div>
        <div className="mt-3 rounded-md border border-slate-200 bg-white p-3">
          <div className="mb-1 text-sm font-medium text-slate-500">
            What you changed
          </div>
          <ProseDiff lines={conflictDiff} />
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button disabled={pending} onClick={() => void save(conflict, draft)}>
            Keep mine (overwrite theirs)
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setDraft(conflict.markdown);
              setBase(conflict);
              setConflict(undefined);
            }}
          >
            Keep theirs (discard mine)
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setBase(conflict);
              setConflict(undefined);
            }}
          >
            Edit on top of theirs
          </Button>
          {error && <span className="text-base text-red-600">{error}</span>}
        </div>
      </div>
    );
  }

  if (mode === "read") {
    return (
      <div className="max-w-5xl">
        {renaming ? (
          <RenameField
            label="Title"
            initial={base.title}
            pending={renamePending}
            error={renameError}
            onSave={(t) => void runRename(t)}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <DocHeader
            slug={base.slug}
            projectId={projectId}
            title={base.title}
            version={base.docVersion}
            active="current"
            onEditTitle={() => setRenaming(true)}
            actions={
              <>
                {deleteError && (
                  <span className="text-base text-red-600">{deleteError}</span>
                )}
                <Button variant="secondary" onClick={enterEdit}>
                  Edit
                </Button>
                <Button
                  variant="danger"
                  disabled={deletePending}
                  onClick={() => void runDelete()}
                >
                  Delete
                </Button>
              </>
            }
            subline={
              renamingFile ? (
                <RenameField
                  label="File name"
                  initial={base.filename}
                  pending={filePending}
                  error={fileError}
                  mono
                  hint="Links from other documents to this file keep resolving — they follow the new name automatically."
                  onSave={(f) => void runRenameFile(f)}
                  onCancel={() => setRenamingFile(false)}
                />
              ) : (
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <span className="font-mono">{base.filename}</span>
                  <button
                    type="button"
                    onClick={() => setRenamingFile(true)}
                    className={textLinkClass("text-sm")}
                  >
                    Rename file
                  </button>
                </div>
              )
            }
          />
        )}
        <Markdown source={base.markdown} />
      </div>
    );
  }

  return (
    <div className="max-w-5xl">
      <PageHeader
        title={base.title}
        meta={
          <span className="text-base text-slate-500">v{base.docVersion}</span>
        }
        actions={
          <Segmented
            ariaLabel="Editor mode"
            value={tab}
            onChange={setTab}
            options={[
              { value: "write", label: "Write" },
              { value: "preview", label: "Preview" },
            ]}
          />
        }
      />
      {tab === "write" ? (
        slugs === undefined ? (
          editorFallback
        ) : (
          <Suspense fallback={editorFallback}>
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
              docSlugs={slugs}
              selfSlug={base.slug}
              onBrokenChange={setBroken}
            />
          </Suspense>
        )
      ) : (
        <Markdown source={draft} bodyClassName="min-h-[28rem]" />
      )}
      <div className="mt-3 flex items-center gap-3">
        <Button disabled={pending} onClick={() => void save(base, draft)}>
          Save
        </Button>
        <Button variant="secondary" disabled={pending} onClick={cancel}>
          Cancel
        </Button>
        {tab === "write" && broken > 0 && (
          <span className="text-base text-amber-700">
            {broken} link{broken > 1 ? "s" : ""} to a missing document
          </span>
        )}
        {error && <span className="text-base text-red-600">{error}</span>}
      </div>
    </div>
  );
}

// Inline filename editor. Distinct from the title rename: filename is
// the path segment for relative-link resolution, so changing it shifts
// Inline metadata editor for title and filename. Both are head-only
// (no version/content change), so they share this lightweight surface
// instead of the read/edit/conflict machinery above. `hint` carries the
// filename-specific note that relative links keep resolving.
function RenameField({
  label,
  initial,
  pending,
  error,
  mono,
  hint,
  onSave,
  onCancel,
}: Readonly<{
  label: string;
  initial: string;
  pending: boolean;
  error?: string | undefined;
  mono?: boolean;
  hint?: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}>): React.ReactElement {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="mb-5 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(value);
      }}
    >
      <Field
        label={label}
        value={value}
        onChange={setValue}
        mono={mono ?? false}
      />
      {hint !== undefined && <p className="text-sm text-slate-500">{hint}</p>}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          Save
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        {error && <span className="text-base text-red-600">{error}</span>}
      </div>
    </form>
  );
}
