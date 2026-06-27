import { useNavigate, useRouter } from "@tanstack/react-router";
import { CheckCircle2, MessageSquareText } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ProseDiff, DiffPanel } from "@/components/diff/Diff";
import { DocHeader } from "@/components/document/DocHeader";
import { Field } from "@/components/Field";
import type {
  ReviewMark,
  SourceRange,
} from "@/components/markdown/live-review";
import { MarkdownEditor } from "@/components/markdown/MarkdownEditor";
import { ReviewComposer } from "@/components/review/Composer";
import { ReviewMobileDialog } from "@/components/review/ReviewPanel";
import {
  ReviewRail,
  type ReviewRailLayout,
} from "@/components/review/ReviewRail";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Card } from "@/components/ui/Surface";
import { textLinkClass } from "@/components/ui/text-link";
import { showToast } from "@/components/ui/Toast";
import type { ProjectId } from "@/ids";
import {
  blockAnchorsToSourceRanges,
  sourceRangeToBlockAnchor,
} from "@/lib/block-offsets";
import { cn } from "@/lib/cn";
import { lineDiff } from "@/lib/diff";
import { useSubmit } from "@/lib/forms";
import { buildReviewModel, type ReviewModel } from "@/lib/review-items";
import {
  createComment,
  type BlockView,
  type CommentsResult,
  type CommentThreadView,
  type CreateCommentResult,
  type DocumentBlocksResult,
} from "@/lib/server/comments";
import {
  archiveDocument,
  type DocSnapshot,
  getDocument,
  renameDocument,
  renameFilename,
  saveDocument,
} from "@/lib/server/documents";
import {
  createSuggestion,
  type CreateSuggestionResult,
  type SuggestionsResult,
} from "@/lib/server/suggestions";
import { useCollab, type RealtimeChange } from "@/lib/use-collab";
import { useFollowDocLink } from "@/lib/use-follow-doc-link";
import { MIN_ANCHOR_CHARS } from "@/store/domain/anchor";

// A transient remote-change cue, keyed by the blocks that moved. The page owns
// this block-indexed shape; it maps the indexes to source ranges before handing
// them to the editor's flash painter (which is block-agnostic).
export type ChangeFlash = Readonly<{
  id: number;
  blockIndexes: readonly number[];
}>;

// The snapshot the page hands the editor when a remote content change arrives,
// so the editor can flash the blocks that moved between this and the new head.
export type VisibleDocSnapshot = Readonly<{
  slug: string;
  docVersion: number;
  markdown: string;
}>;

const EMPTY_BLOCKS: readonly [] = [];
const EMPTY_FLASH: readonly SourceRange[] = [];
const EMPTY_MARKS: readonly ReviewMark[] = [];
const EMPTY_REVIEW_LAYOUT: ReviewRailLayout = {
  itemTops: {},
  documentHeight: 0,
};

export function DocumentEditor({
  doc,
  projectId,
  blocks,
  comments,
  suggestions,
  viewerId,
  slugs,
  changeFlash,
  onRemoteContentChange,
  onRemoteSuggestionChange,
}: Readonly<{
  doc: DocSnapshot;
  projectId: ProjectId;
  blocks: DocumentBlocksResult;
  comments: CommentsResult;
  suggestions: SuggestionsResult;
  viewerId: string;
  slugs: readonly string[];
  changeFlash?: ChangeFlash | undefined;
  onRemoteContentChange: (snapshot: VisibleDocSnapshot) => void;
  onRemoteSuggestionChange: (
    slug: string,
    seenSuggestionIds: readonly number[],
  ) => void;
}>): React.ReactElement {
  const router = useRouter();
  // The document is one always-editable surface; comments and suggestions are
  // created and shown inline on the editor itself (no separate review view), with
  // the threads in a margin rail. The editor reports where each anchor sits so
  // the rail lines up beside it.
  const [reviewLayout, setReviewLayout] =
    useState<ReviewRailLayout>(EMPTY_REVIEW_LAYOUT);
  const [renaming, setRenaming] = useState(false);
  const [renamingFile, setRenamingFile] = useState(false);
  const [reviewDismissed, setReviewDismissed] = useState(false);
  const [mobileReviewOpen, setMobileReviewOpen] = useState(false);
  const [draft, setDraft] = useState(doc.markdown);
  const [broken, setBroken] = useState(0);
  // The version a save is optimistically checked against. Starts at the
  // loaded doc; after resolving a 409 without overwriting it advances to
  // the fetched head, so the next save doesn't immediately re-conflict.
  // A successful save remounts this component (version key), resetting it.
  const [base, setBase] = useState<DocSnapshot>(doc);
  const [conflict, setConflict] = useState<DocSnapshot>();
  const head = base.updatedAt >= doc.updatedAt ? base : doc;
  const dirty = draft !== head.markdown;

  // "Never lose a write" extends to the tab-close edge: if the user
  // has unsaved changes and tries to close/refresh the tab, the browser
  // shows its native leave-site confirmation. The handler is a no-op
  // when the draft is clean so it never blocks navigation on save.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [dirty]);

  const refreshRoute = useCallback((): void => {
    void router.invalidate();
  }, [router]);

  // The DO broadcasts every write to all sockets, including the actor's own.
  // Identify self-echoes by actor id (web writes stamp the viewer's id) so we
  // refresh but skip the flash/toast for our own edits — without ever muting a
  // genuine concurrent change from someone else.
  const handleCollabChanged = useCallback(
    (change: RealtimeChange | undefined): void => {
      const isSelf =
        change?.actorId !== undefined && change.actorId === viewerId;
      if (!isSelf && shouldFlashContentChange(change, head.slug)) {
        onRemoteContentChange({
          slug: head.slug,
          docVersion: head.docVersion,
          markdown: head.markdown,
        });
      }
      if (!isSelf && shouldFlashSuggestionChange(change, head.slug)) {
        onRemoteSuggestionChange(
          head.slug,
          suggestions.suggestions.map((s) => s.id),
        );
      }
      refreshRoute();
      if (isSelf) return;
      const message = collabToastMessage(change, head.slug);
      if (message !== undefined) showToast(message);
    },
    [
      head.docVersion,
      head.markdown,
      head.slug,
      onRemoteContentChange,
      onRemoteSuggestionChange,
      refreshRoute,
      suggestions.suggestions,
      viewerId,
    ],
  );

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
  const presence = useCollab(projectId, head.slug, handleCollabChanged);
  // Memoized: presence only changes on WebSocket messages, but this component
  // re-renders on every keystroke (draft state). Without memo, the filter
  // allocates a new array per keystroke.
  const here = useMemo(
    () => presence.filter((p) => p.docSlug === head.slug),
    [presence, head.slug],
  );
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

  // A string signature of the open threads, so the comment marks memo can
  // skip the per-block remark parse (blockAnchorsToSourceRanges) when a
  // collab ping refreshes the loader (new array identity) but the open
  // thread set is unchanged. Thread anchors are immutable (stored at
  // creation), so id + anchor position fully capture the parse inputs.
  const openThreadSig = useMemo(
    () =>
      comments.threads
        .filter((t) => t.status === "open")
        .map(
          (t) => `${t.id}:${t.anchorBlockId}:${t.anchorStart}:${t.anchorEnd}`,
        )
        .join(","),
    [comments.threads],
  );

  // Comment marks: the expensive half of editorMarks. Threads are grouped by
  // block first, then blockAnchorsToSourceRanges resolves every thread on a
  // block against ONE remark parse of that block's source slice — several
  // open threads on the same block (a common case) share that parse instead
  // of re-parsing once per thread. The result depends only on head.markdown
  // (which determines block source positions) and the open thread set
  // (captured by openThreadSig); when neither has changed — e.g. a
  // presence-only collab ping — the memo returns the cached result without
  // any remark parses at all.
  const commentMarks = useMemo<readonly ReviewMark[]>(() => {
    const byId = new Map<string, BlockView>();
    for (const block of documentBlocks) {
      if (block.id !== undefined) byId.set(block.id, block);
    }
    const threadsByBlock = new Map<BlockView, CommentThreadView[]>();
    for (const thread of comments.threads) {
      if (thread.status !== "open") continue;
      const block = byId.get(thread.anchorBlockId);
      if (block === undefined) continue;
      const threads = threadsByBlock.get(block);
      if (threads === undefined) threadsByBlock.set(block, [thread]);
      else threads.push(thread);
    }
    const marks: ReviewMark[] = [];
    for (const [block, threads] of threadsByBlock) {
      const ranges = blockAnchorsToSourceRanges(
        block,
        head.markdown,
        threads.map((t) => ({
          start: t.anchorStart,
          end: t.anchorEnd,
          quote: t.quote,
        })),
      );
      threads.forEach((thread, i) => {
        const range = ranges[i];
        if (range !== undefined) {
          marks.push({
            id: `comment:${thread.id}`,
            kind: "comment",
            from: range[0],
            to: range[1],
          });
        }
      });
    }
    return marks;
    // openThreadSig (string, value-compared) replaces comments.threads (array,
    // reference-compared) so a collab ping with the same open threads skips the
    // remark parse. head.markdown (string, value-compared) captures the block
    // positions that documentBlocks (array, reference-compared) is derived from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openThreadSig, head.markdown]);

  // Suggestion marks: cheap (source-native hunk positions, no parse). Kept
  // separate so suggestion changes don't force the comment marks to recompute.
  const suggestionMarks = useMemo<readonly ReviewMark[]>(() => {
    const marks: ReviewMark[] = [];
    for (const suggestion of suggestions.suggestions) {
      if (
        suggestion.status !== "open" ||
        suggestion.baseDocVersion !== docVersion
      ) {
        continue;
      }
      for (const hunk of suggestion.hunks) {
        marks.push({
          id: `suggestion:${suggestion.id}`,
          kind: hunk.op,
          from: hunk.baseStart,
          to: hunk.op === "insert" ? hunk.baseStart : hunk.baseEnd,
        });
      }
    }
    return marks;
  }, [suggestions.suggestions, docVersion]);

  const editorMarks = useMemo<readonly ReviewMark[]>(
    () => [...commentMarks, ...suggestionMarks],
    [commentMarks, suggestionMarks],
  );

  const flashRanges = useMemo<readonly SourceRange[]>(() => {
    if (changeFlash === undefined) return EMPTY_FLASH;
    const out: SourceRange[] = [];
    for (const index of changeFlash.blockIndexes) {
      const block = documentBlocks[index];
      if (block !== undefined) {
        out.push({ from: block.sourceStart, to: block.sourceEnd });
      }
    }
    return out;
  }, [changeFlash, documentBlocks]);

  const updateReviewLayout = useCallback((next: ReviewRailLayout): void => {
    setReviewLayout((current) =>
      sameReviewLayout(current, next) ? current : next,
    );
  }, []);

  function discard() {
    setDraft(head.markdown);
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
  // Cmd/Ctrl-click on a rendered link follows it: external opens a new tab, an
  // in-project slug routes within the project (hook so it stays above the
  // conflict early-return — Rules of Hooks).
  const followLink = useFollowDocLink(projectId);
  const {
    pending: deletePending,
    error: deleteError,
    run: runDelete,
  } = useSubmit(async () => {
    const ok = await confirmDialog({
      title: `Delete "${head.title}"?`,
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
              // Adopt their version: refresh so blocks/comments/docVersion match
              // the new head (else review marks + clientVersion stay stale).
              refreshRoute();
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

  // The inline Comment/Suggest popover for the current editor selection. Review
  // anchors to the SAVED document (offsets line up only when clean), so an
  // unsaved draft prompts a Save first instead of the composer.
  const renderReviewPopover = ({
    from,
    to,
    dismiss,
  }: Readonly<{
    from: number;
    to: number;
    dismiss: () => void;
  }>): React.ReactNode => {
    if (dirty) {
      return (
        <Card className="w-72 space-y-2 p-3 shadow-md">
          <p className="text-sm text-slate-600">
            Save your changes to comment or suggest on the document.
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              disabled={pending}
              onClick={() => void save(head, draft)}
            >
              Save
            </Button>
            <Button type="button" variant="secondary" onClick={dismiss}>
              Cancel
            </Button>
          </div>
        </Card>
      );
    }
    const anchor = sourceRangeToBlockAnchor(documentBlocks, draft, from, to);
    const quote =
      anchor === undefined
        ? draft.slice(from, to)
        : (documentBlocks[anchor.blockIndex]?.text.slice(
            anchor.start,
            anchor.end,
          ) ?? draft.slice(from, to));
    return (
      <ReviewComposer
        quote={quote}
        initialSuggest={draft.slice(from, to)}
        // Offer Comment whenever the selection is anchorable; the length minimum
        // is shown as an inline hint in the composer (not a hidden option).
        canComment={anchor !== undefined}
        commentMinChars={MIN_ANCHOR_CHARS}
        onComment={async (body) => {
          if (anchor === undefined) {
            return "Select text within a single block to comment.";
          }
          const r = await createComment({
            data: {
              projectId,
              slug: head.slug,
              blockIndex: anchor.blockIndex,
              start: anchor.start,
              end: anchor.end,
              body,
              clientVersion: docVersion,
            },
          });
          if (!r.ok) return commentErrorMessage(r.reason);
          showToast("Comment added");
          refreshRoute();
          return undefined;
        }}
        onSuggest={(edited) =>
          onSuggestSelection(draft.slice(0, from) + edited + draft.slice(to))
        }
        onCancel={dismiss}
      />
    );
  };

  const subline = renamingFile ? (
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
  );

  // The header stays stable (just Delete); the editing controls live in a sticky
  // bar (below) so they never crowd the title and stay reachable while editing
  // deep in a long document. Comment/suggest is inline on the editor.
  const headerActions = (
    <>
      {deleteError && (
        <span className="text-base text-red-600">{deleteError}</span>
      )}
      <Button
        variant="danger"
        disabled={deletePending}
        onClick={() => void runDelete()}
      >
        Delete
      </Button>
    </>
  );

  // Sticky editing toolbar: appears only when there are unsaved changes.
  // Pinned to the BOTTOM so it never shifts the editor or the review rail
  // (whose comments are positioned relative to editor text). A top bar
  // that appears on first keystroke pushes everything down — jarring.
  const editBar = dirty && (
    <div className="sticky bottom-0 z-20 mt-4 flex flex-wrap items-center gap-3 border-t border-slate-200 bg-white py-3">
      <span className="text-sm font-medium text-slate-600">
        Unsaved changes
      </span>
      <Button disabled={pending} onClick={() => void save(head, draft)}>
        Save
      </Button>
      <Button variant="secondary" onClick={discard}>
        Discard
      </Button>
      <Button
        variant="secondary"
        disabled={suggesting}
        onClick={() => void suggest()}
      >
        Suggest changes
      </Button>
      {broken > 0 && (
        <span className="text-sm text-amber-700">
          {broken} link{broken > 1 ? "s" : ""} to a missing document
        </span>
      )}
      {error && <span className="text-sm text-red-600">{error}</span>}
      {suggestError !== undefined && (
        <span className="text-sm text-red-600">{suggestError}</span>
      )}
    </div>
  );

  // Desktop passes the measured layout (positions cards beside their text);
  // the mobile dialog passes the empty layout so the rail stacks instead.
  const rail = (layout: ReviewRailLayout): React.ReactElement => (
    <ReviewRail
      projectId={projectId}
      items={reviewModel.items}
      commentNames={comments.names}
      suggestionNames={suggestions.names}
      baseMarkdown={head.markdown}
      presence={here}
      layout={layout}
      onChange={refreshRoute}
    />
  );

  return (
    <div className={showReview ? "max-w-7xl" : "mx-auto max-w-doc"}>
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
          actions={headerActions}
          subline={subline}
        />
      )}
      <div
        className={cn(
          "min-w-0",
          showReview
            ? "grid items-start gap-6 lg:grid-cols-[minmax(0,var(--container-doc))_20rem] xl:gap-8"
            : "max-w-doc",
        )}
      >
        <div className="min-w-0">
          <MarkdownEditor
            fill
            review
            value={draft}
            onChange={setDraft}
            docSlugs={slugs}
            selfSlug={head.slug}
            onBrokenChange={setBroken}
            ariaLabel={`Edit document body: ${head.title}`}
            onSave={() => void save(head, draft)}
            onFollowLink={followLink}
            // Review anchors are saved-document coordinates; while the draft has
            // diverged they would paint on the wrong text, so suppress them
            // until the doc is clean again (Save or Discard re-paints).
            reviewMarks={dirty ? EMPTY_MARKS : editorMarks}
            flashRanges={dirty ? EMPTY_FLASH : flashRanges}
            onReviewLayoutChange={updateReviewLayout}
            renderReviewPopover={renderReviewPopover}
          />
        </div>
        {showReview && (
          <div className="hidden lg:block">{rail(reviewLayout)}</div>
        )}
      </div>
      {editBar}
      <ReviewMobileDialog
        open={mobileReviewOpen && showReview}
        onOpenChange={setMobileReviewOpen}
      >
        {rail(EMPTY_REVIEW_LAYOUT)}
      </ReviewMobileDialog>
    </div>
  );
}

function sameReviewLayout(a: ReviewRailLayout, b: ReviewRailLayout): boolean {
  if (a.documentHeight !== b.documentHeight) return false;
  const aKeys = Object.keys(a.itemTops);
  const bKeys = Object.keys(b.itemTops);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a.itemTops[key] === b.itemTops[key]);
}

type CreateCommentFailureReason = Extract<
  CreateCommentResult,
  { ok: false }
>["reason"];

function commentErrorMessage(reason: CreateCommentFailureReason): string {
  if (reason === "conflict")
    return "The document changed; reload and try again.";
  if (reason === "anchor-too-short")
    return `Select at least ${MIN_ANCHOR_CHARS} characters.`;
  return "Could not add the comment.";
}

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

function collabToastMessage(
  change: RealtimeChange | undefined,
  currentSlug: string,
): string | undefined {
  if (change?.docSlug !== currentSlug) return undefined;
  const actor = change.actorName ?? "Someone";
  switch (change.action) {
    case "document.created":
    case "document.updated":
      return `${actor} updated this document`;
    case "document.renamed":
      return `${actor} renamed this document`;
    case "document.filename_changed":
      return `${actor} renamed this file`;
    case "document.archived":
      return `${actor} deleted this document`;
    case "comment.created":
      return `${actor} commented on this document`;
    case "comment.replied":
      return `${actor} replied in review`;
    case "comment.resolved":
      return `${actor} resolved a comment`;
    case "suggestion.created":
      return change.channel === "mcp"
        ? "An agent proposed an edit via MCP"
        : `${actor} suggested an edit`;
    case "suggestion.applied":
      return `${actor} applied accepted changes`;
    case "suggestion.rejected":
      return `${actor} rejected a suggestion`;
    case "project.changed":
    case "collection.created":
    case "collection.updated":
    case "collection.attached":
    case "collection.detached":
    case "collection.reordered":
      // Project/collection-level changes don't warrant a per-document toast.
      return undefined;
    default: {
      // Exhaustiveness: a new RealtimeChange action must be handled here (or
      // explicitly silenced above) rather than silently dropping its toast.
      const unexpected: never = change.action;
      return unexpected;
    }
  }
}

function shouldFlashContentChange(
  change: RealtimeChange | undefined,
  currentSlug: string,
): boolean {
  return (
    change?.docSlug === currentSlug &&
    (change.action === "document.updated" ||
      change.action === "suggestion.applied")
  );
}

function shouldFlashSuggestionChange(
  change: RealtimeChange | undefined,
  currentSlug: string,
): boolean {
  return (
    change?.docSlug === currentSlug && change.action === "suggestion.created"
  );
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
            ? "rounded-full bg-emerald-50 px-1.5 py-0.5 text-sm font-medium text-emerald-700"
            : "rounded-full bg-amber-50 px-1.5 py-0.5 text-sm font-medium text-amber-700"
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
