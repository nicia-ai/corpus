import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { markdownEditorHostClass } from "@/components/markdown/host-class";
import { CHANGE_FLASH_DURATION_MS } from "@/components/markdown/live-review";
import type {
  ChangeFlash,
  VisibleDocSnapshot,
} from "@/features/documents/DocumentEditor";
import type { ProjectId } from "@/ids";
import { changedBlockIndexes } from "@/lib/changed-blocks";
import type {
  BlockView,
  CommentsResult,
  DocumentBlocksResult,
} from "@/lib/server/comments";
import type { DocSnapshot } from "@/lib/server/documents";
import type { SuggestionsResult } from "@/lib/server/suggestions";

// CodeMirror (+ live-preview + language-data) only loads when a reader first
// enters this page — it stays out of the read path's route chunk (the
// primary audience reads, not edits; PRODUCT.md).
const DocumentEditor = lazy(() =>
  import("@/features/documents/DocumentEditor").then((m) => ({
    default: m.DocumentEditor,
  })),
);

// Same box class the mounted editor uses (host-class.ts), so the Suspense
// fallback can't drift out of sync with it.
const documentEditorFallback = <div className={markdownEditorHostClass} />;

// A remote change the page hasn't flashed yet. `content` carries the
// pre-change snapshot so the flash can diff against the new head; `suggestion`
// carries the suggestion ids already seen so only new ones flash.
type RemoteFlashRequest = Readonly<
  | {
      id: number;
      kind: "content";
      slug: string;
      fromDocVersion: number;
      fromMarkdown: string;
    }
  | {
      id: number;
      kind: "suggestion";
      slug: string;
      seenSuggestionIds: readonly number[];
    }
>;

export function DocumentCurrentPage({
  doc,
  projectId,
  blocks,
  comments,
  suggestions,
  viewerId,
  slugs,
}: Readonly<{
  doc: DocSnapshot | undefined;
  projectId: ProjectId;
  blocks: DocumentBlocksResult;
  comments: CommentsResult;
  suggestions: SuggestionsResult;
  viewerId: string;
  slugs: readonly string[];
}>): React.ReactElement | null {
  const nextFlashId = useRef(0);
  const [remoteFlashRequest, setRemoteFlashRequest] =
    useState<RemoteFlashRequest>();

  const queueRemoteContentFlash = useCallback(
    (snapshot: VisibleDocSnapshot): void => {
      setRemoteFlashRequest({
        id: (nextFlashId.current += 1),
        kind: "content",
        slug: snapshot.slug,
        fromDocVersion: snapshot.docVersion,
        fromMarkdown: snapshot.markdown,
      });
    },
    [],
  );
  const queueRemoteSuggestionFlash = useCallback(
    (slug: string, seenSuggestionIds: readonly number[]): void => {
      setRemoteFlashRequest({
        id: (nextFlashId.current += 1),
        kind: "suggestion",
        slug,
        seenSuggestionIds,
      });
    },
    [],
  );

  // Drop the request once its flash window elapses, so `changeFlash` returns
  // to undefined: stops the per-render recompute and the stale replay on a
  // later edit→read toggle.
  useEffect(() => {
    if (remoteFlashRequest === undefined) return undefined;
    const id = window.setTimeout(
      () => setRemoteFlashRequest(undefined),
      CHANGE_FLASH_DURATION_MS,
    );
    return () => window.clearTimeout(id);
  }, [remoteFlashRequest]);

  // Memoized so its identity is stable across unrelated re-renders (presence
  // pings), which would otherwise re-run the heavy measure/highlight effect.
  const changeFlash = useMemo(
    (): ChangeFlash | undefined =>
      doc !== undefined && blocks.found && remoteFlashRequest?.slug === doc.slug
        ? changeFlashFor({
            request: remoteFlashRequest,
            doc,
            blocks: blocks.blocks,
            suggestions: suggestions.suggestions,
          })
        : undefined,
    [doc, blocks, remoteFlashRequest, suggestions.suggestions],
  );

  if (doc === undefined) return null;

  // Keyed by version: a successful save invalidates the loader, the new
  // version remounts the editor with a fresh draft — no useEffect re-seeding.
  return (
    <Suspense fallback={documentEditorFallback}>
      <DocumentEditor
        key={doc.docVersion}
        doc={doc}
        projectId={projectId}
        blocks={blocks}
        comments={comments}
        suggestions={suggestions}
        viewerId={viewerId}
        slugs={slugs}
        changeFlash={changeFlash}
        onRemoteContentChange={queueRemoteContentFlash}
        onRemoteSuggestionChange={queueRemoteSuggestionFlash}
      />
    </Suspense>
  );
}

type SuggestionForFlash = SuggestionsResult["suggestions"][number];
type SuggestionHunkForFlash = SuggestionForFlash["hunks"][number];

function changeFlashFor({
  request,
  doc,
  blocks,
  suggestions,
}: Readonly<{
  request: RemoteFlashRequest;
  doc: DocSnapshot;
  blocks: readonly BlockView[];
  suggestions: readonly SuggestionForFlash[];
}>): ChangeFlash | undefined {
  if (request.kind === "content") {
    if (
      request.fromDocVersion === doc.docVersion ||
      request.fromMarkdown === doc.markdown
    ) {
      return undefined;
    }
    const blockIndexes = changedBlockIndexes(request.fromMarkdown, blocks);
    return blockIndexes.length === 0
      ? undefined
      : { id: request.id, blockIndexes };
  }

  const seen = new Set(request.seenSuggestionIds);
  const blockIndexes = new Set<number>();
  for (const suggestion of suggestions) {
    if (seen.has(suggestion.id) || suggestion.status !== "open") continue;
    // A hunk's baseStart/baseEnd index the version it was created against; the
    // blocks here are the current head. Only flash when they're the same
    // coordinate system, else the overlap math points at the wrong block.
    if (suggestion.baseDocVersion !== doc.docVersion) continue;
    for (const hunk of suggestion.hunks) {
      for (const index of blockIndexesForHunk(hunk, blocks)) {
        blockIndexes.add(index);
      }
    }
  }
  return blockIndexes.size === 0
    ? undefined
    : { id: request.id, blockIndexes: [...blockIndexes] };
}

function blockIndexesForHunk(
  hunk: SuggestionHunkForFlash,
  blocks: readonly BlockView[],
): readonly number[] {
  if (hunk.baseEnd > hunk.baseStart) {
    const covered = blocks
      .filter(
        (block) =>
          hunk.baseStart <= block.sourceStart &&
          hunk.baseEnd >= block.sourceEnd,
      )
      .map((block) => block.index);
    if (covered.length > 0) return covered;

    return blocks
      .filter(
        (block) =>
          hunk.baseStart < block.sourceEnd && hunk.baseEnd > block.sourceStart,
      )
      .map((block) => block.index);
  }

  const after = blocks.find(
    (block) => block.text.length > 0 && block.sourceStart >= hunk.baseStart,
  );
  let before: BlockView | undefined;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (
      block !== undefined &&
      block.text.length > 0 &&
      block.sourceEnd <= hunk.baseStart
    ) {
      before = block;
      break;
    }
  }
  return before !== undefined
    ? [before.index]
    : after === undefined
      ? []
      : [after.index];
}
