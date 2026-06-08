import { useNavigate, useRouter } from "@tanstack/react-router";
import { CheckCircle2, MessageSquareText } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";

import { ProseDiff, DiffPanel } from "@/components/diff/Diff";
import { DocHeader } from "@/components/document/DocHeader";
import { Field } from "@/components/Field";
import { Markdown } from "@/components/markdown/Markdown";
import { ReviewWorkspace } from "@/components/review/ReviewWorkspace";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { textLinkClass } from "@/components/ui/text-link";
import { showToast } from "@/components/ui/Toast";
import type { ProjectId } from "@/ids";
import { lineDiff } from "@/lib/diff";
import { useSubmit } from "@/lib/forms";
import { buildReviewModel, type ReviewModel } from "@/lib/review-items";
import type {
  CommentsResult,
  DocumentBlocksResult,
} from "@/lib/server/comments";
import {
  archiveDocument,
  type DocSnapshot,
  getDocument,
  getDocuments,
  renameDocument,
  renameFilename,
  saveDocument,
} from "@/lib/server/documents";
import {
  createSuggestion,
  type CreateSuggestionResult,
  type SuggestionsResult,
} from "@/lib/server/suggestions";
import { useCollab } from "@/lib/use-collab";

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
  blocks,
  comments,
  suggestions,
}: Readonly<{
  doc: DocSnapshot | undefined;
  projectId: ProjectId;
  blocks: DocumentBlocksResult;
  comments: CommentsResult;
  suggestions: SuggestionsResult;
}>): React.ReactElement | null {
  if (doc === undefined) return null;

  // Keyed by version: a successful save invalidates the loader, the new
  // version remounts Editor with a fresh draft — no useEffect re-seeding.
  return (
    <Editor
      key={doc.docVersion}
      doc={doc}
      projectId={projectId}
      blocks={blocks}
      comments={comments}
      suggestions={suggestions}
    />
  );
}

function Editor({
  doc,
  projectId,
  blocks,
  comments,
  suggestions,
}: Readonly<{
  doc: DocSnapshot;
  projectId: ProjectId;
  blocks: DocumentBlocksResult;
  comments: CommentsResult;
  suggestions: SuggestionsResult;
}>): React.ReactElement {
  const router = useRouter();
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [renaming, setRenaming] = useState(false);
  const [renamingFile, setRenamingFile] = useState(false);
  const [reviewDismissed, setReviewDismissed] = useState(false);
  const [mobileReviewOpen, setMobileReviewOpen] = useState(false);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [draft, setDraft] = useState(doc.markdown);
  const [broken, setBroken] = useState(0);
  // The version a save is optimistically checked against. Starts at the
  // loaded doc; after resolving a 409 without overwriting it advances to
  // the fetched head, so the next save doesn't immediately re-conflict.
  // A successful save remounts this component (version key), resetting it.
  const [base, setBase] = useState<DocSnapshot>(doc);
  const [conflict, setConflict] = useState<DocSnapshot>();
  const head = base.updatedAt >= doc.updatedAt ? base : doc;

  // Slugs feed the editor's broken-link linter and matter only in edit
  // mode, so they load on first edit (not in the loader — every read view,
  // the common case, would otherwise pull the whole document list).
  const [slugs, setSlugs] = useState<readonly string[]>();
  const { run: loadSlugs } = useSubmit(async () => {
    setSlugs((await getDocuments({ data: { projectId } })).map((d) => d.slug));
  });

  function refreshRoute(): void {
    void router.invalidate();
  }

  // Suggestions use the Current route loader in read mode; this edit-mode
  // action creates one, then invalidates the loader so the review workspace
  // shows it inline without a detached secondary fetch.
  const {
    pending: suggesting,
    error: suggestError,
    run: suggest,
  } = useSubmit(async () => {
    const r = await createSuggestion({
      data: {
        projectId,
        slug: head.slug,
        proposedMarkdown: draft,
        clientVersion: head.docVersion,
      },
    });
    if (!r.ok) {
      throw new Error(
        suggestionErrorMessage(r.reason, "No changes to suggest."),
      );
    }
    showToast("Suggestion created");
    setMode("read");
    refreshRoute();
  });

  // Select-to-suggest from the read view: propose an edit to one block's
  // source. Returns an error message (or undefined) so the popover can show
  // feedback inline.
  const onSuggestSelection = async (
    proposed: string,
  ): Promise<string | undefined> => {
    const r = await createSuggestion({
      data: {
        projectId,
        slug: head.slug,
        proposedMarkdown: proposed,
        clientVersion: blocks.found ? blocks.docVersion : head.docVersion,
      },
    });
    if (!r.ok) {
      return suggestionErrorMessage(r.reason, "No change to suggest.");
    }
    showToast("Suggestion created");
    refreshRoute();
    return undefined;
  };

  // Presence + live nudges over the project's real-time channel. On a change
  // (anyone's write), refresh the document + review loader.
  const presence = useCollab(projectId, head.slug, refreshRoute);
  const here = presence.filter((p) => p.docSlug === head.slug);
  const docVersion = blocks.found ? blocks.docVersion : head.docVersion;
  const documentBlocks = blocks.found ? blocks.blocks : EMPTY_BLOCKS;
  const reviewModel = useMemo(
    () =>
      buildReviewModel({
        blocks: documentBlocks,
        threads: comments.threads,
        suggestions: suggestions.suggestions,
        docVersion,
      }),
    [comments.threads, docVersion, documentBlocks, suggestions.suggestions],
  );
  const hasReviewItems = reviewModel.items.length > 0;
  const reviewDismissedNow = reviewDismissed && reviewModel.activeCount === 0;
  const showReview = hasReviewItems && !reviewDismissedNow;
  const reviewComplete = hasReviewItems && reviewModel.activeCount === 0;

  function enterEdit() {
    if (head !== base) {
      setBase(head);
      setDraft(head.markdown);
    }
    setMode("edit");
    if (slugs === undefined) void loadSlugs();
  }
  function cancel() {
    setDraft(head.markdown);
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
    if (t === "" || t === head.title) {
      setRenaming(false);
      return;
    }
    const r = await renameDocument({
      data: { projectId, slug: head.slug, title: t },
    });
    if (!r.ok) throw new Error("Rename failed — please retry.");
    // A rename doesn't bump docVersion, so the version-key remount that
    // re-seeds after a content save never fires here. Update the local
    // head optimistically (the server accepted it); onSaved() flashes +
    // invalidates so other routes' loaders pick up the new title.
    setBase({ ...head, title: t });
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
    if (f === "" || f === head.filename) {
      setRenamingFile(false);
      return;
    }
    const r = await renameFilename({
      data: { projectId, slug: head.slug, filename: f },
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
    setBase({ ...head, filename: f });
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
      title: `Delete “${head.title}”?`,
      body: "It is removed from all collections and hidden. History is kept.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    const r = await archiveDocument({
      data: { projectId, slug: head.slug },
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
      <div className={hasReviewItems ? "max-w-7xl" : "max-w-5xl"}>
        {renaming ? (
          <RenameField
            label="Title"
            initial={head.title}
            pending={renamePending}
            error={renameError}
            onSave={(t) => void runRename(t)}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <DocHeader
            slug={head.slug}
            projectId={projectId}
            title={head.title}
            version={head.docVersion}
            active="current"
            onEditTitle={() => setRenaming(true)}
            tabAccessory={
              hasReviewItems ? (
                <ReviewTabSummary
                  model={reviewModel}
                  complete={reviewComplete}
                  dismissed={reviewDismissedNow}
                  onOpenMobile={() => setMobileReviewOpen(true)}
                  onShowReview={() => setReviewDismissed(false)}
                  onFinish={() => setReviewDismissed(true)}
                />
              ) : undefined
            }
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
                  initial={head.filename}
                  pending={filePending}
                  error={fileError}
                  mono
                  hint="Links from other documents to this file keep resolving — they follow the new name automatically."
                  onSave={(f) => void runRenameFile(f)}
                  onCancel={() => setRenamingFile(false)}
                />
              ) : (
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <span className="font-mono">{head.filename}</span>
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
        <ReviewWorkspace
          projectId={projectId}
          slug={head.slug}
          markdown={head.markdown}
          docVersion={docVersion}
          blocks={documentBlocks}
          comments={comments}
          suggestions={suggestions}
          model={reviewModel}
          presence={here}
          showReview={showReview}
          mobileOpen={mobileReviewOpen}
          onMobileOpenChange={setMobileReviewOpen}
          onChange={refreshRoute}
          onSuggest={onSuggestSelection}
        />
      </div>
    );
  }

  return (
    <div className="max-w-5xl">
      <PageHeader
        title={head.title}
        meta={
          <span className="text-base text-slate-500">v{head.docVersion}</span>
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
              selfSlug={head.slug}
              onBrokenChange={setBroken}
            />
          </Suspense>
        )
      ) : (
        <Markdown source={draft} bodyClassName="min-h-[28rem]" />
      )}
      <div className="mt-3 flex items-center gap-3">
        <Button disabled={pending} onClick={() => void save(head, draft)}>
          Save
        </Button>
        <Button variant="secondary" disabled={pending} onClick={cancel}>
          Cancel
        </Button>
        <Button
          variant="secondary"
          disabled={suggesting}
          onClick={() => void suggest()}
        >
          Suggest changes
        </Button>
        {suggestError !== undefined && (
          <span className="text-base text-red-600">{suggestError}</span>
        )}
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

const EMPTY_BLOCKS: readonly [] = [];

type CreateSuggestionFailureReason = Extract<
  CreateSuggestionResult,
  { ok: false }
>["reason"];

function suggestionErrorMessage(
  reason: CreateSuggestionFailureReason,
  noChangeMessage: string,
): string {
  if (reason === "no-change") return noChangeMessage;
  if (reason === "conflict")
    return "The document changed — reload and try again.";
  return "Could not create the suggestion.";
}

function ReviewTabSummary({
  model,
  complete,
  dismissed,
  onOpenMobile,
  onShowReview,
  onFinish,
}: Readonly<{
  model: ReviewModel;
  complete: boolean;
  dismissed: boolean;
  onOpenMobile: () => void;
  onShowReview: () => void;
  onFinish: () => void;
}>): React.ReactElement {
  if (dismissed) {
    return (
      <span className="inline-flex min-w-0 flex-wrap items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-sm text-emerald-800">
        <CheckCircle2 className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="font-medium">Review complete</span>
        <button
          type="button"
          onClick={onShowReview}
          className="hidden font-medium text-blue-700 hover:text-blue-800 lg:inline"
        >
          Show review
        </button>
        <button
          type="button"
          onClick={() => {
            onShowReview();
            onOpenMobile();
          }}
          className="font-medium text-blue-700 hover:text-blue-800 lg:hidden"
        >
          Show review
        </button>
      </span>
    );
  }

  const activeKinds = [
    model.activeCommentCount > 0
      ? `${model.activeCommentCount} comment${model.activeCommentCount === 1 ? "" : "s"}`
      : undefined,
    model.activeSuggestionCount > 0
      ? `${model.activeSuggestionCount} suggestion${model.activeSuggestionCount === 1 ? "" : "s"}`
      : undefined,
  ].filter((s): s is string => s !== undefined);

  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-2 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-sm text-slate-600">
      {complete ? (
        <CheckCircle2
          className="size-3.5 shrink-0 text-emerald-600"
          aria-hidden="true"
        />
      ) : (
        <MessageSquareText
          className="size-3.5 shrink-0 text-amber-600"
          aria-hidden="true"
        />
      )}
      <span className="font-medium text-slate-900">Review</span>
      <span
        className={
          complete
            ? "rounded-full bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700"
            : "rounded-full bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700"
        }
      >
        {complete ? "complete" : `${model.activeCount} open`}
      </span>
      {!complete && activeKinds.length > 0 && (
        <span className="text-slate-500">{activeKinds.join(" · ")}</span>
      )}
      {model.staleSuggestionCount > 0 && (
        <span className="text-amber-700">
          {model.staleSuggestionCount} stale suggestion
          {model.staleSuggestionCount === 1 ? "" : "s"}
        </span>
      )}
      <button
        type="button"
        onClick={onOpenMobile}
        className="font-medium text-blue-600 hover:text-blue-700 lg:hidden"
      >
        Open review
      </button>
      {complete && (
        <button
          type="button"
          onClick={onFinish}
          className="font-medium text-blue-600 hover:text-blue-700"
        >
          Finish review
        </button>
      )}
    </span>
  );
}

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
