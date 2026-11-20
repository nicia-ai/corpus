import { useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { useDialogFocusTrap } from "@/components/ui/dialog-focus";
import type { ProjectId } from "@/ids";
import { useSubmit } from "@/lib/forms";
import {
  type CorpusListItem,
  deleteCorpus,
  type DeleteCorpusOutcome,
} from "@/lib/server/corpora";
import type { CorpusDeletePageMode } from "@/project-store/contracts";

const PAGE_CHOICES: readonly Readonly<{
  mode: CorpusDeletePageMode;
  label: string;
  detail: string;
}>[] = [
  {
    mode: "archive",
    label: "Delete its pages too",
    detail:
      "Pages are archived, not erased: their history stays on record. Their share links stop working.",
  },
  {
    mode: "move-to-default",
    label: "Move its pages to Drafts",
    detail:
      "Pages are kept, unpublished. Agents can no longer read them until you move them into a corpus.",
  },
];

// Deleting a corpus asks what becomes of its pages. Deleting them is
// pre-selected, and the copy says what that does and does not do. The
// agents connected to the corpus are disconnected either way.
export function DeleteCorpusDialog({
  projectId,
  corpus,
  onClose,
  onDeleted,
}: Readonly<{
  projectId: ProjectId;
  corpus: Pick<CorpusListItem, "slug" | "name" | "documentCount">;
  onClose: () => void;
  onDeleted: (outcome: Extract<DeleteCorpusOutcome, { ok: true }>) => void;
}>): React.ReactElement {
  const [pages, setPages] = useState<CorpusDeletePageMode>("archive");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogFocusTrap({
    open: true,
    onClose,
    initialFocus: cancelRef,
  });
  const { pending, error, run } = useSubmit(async () => {
    const outcome = await deleteCorpus({
      data: { projectId, slug: corpus.slug, pages },
    });
    if (!outcome.ok) {
      throw new Error(
        outcome.reason === "default-corpus"
          ? "Drafts can’t be deleted."
          : "That corpus no longer exists.",
      );
    }
    onDeleted(outcome);
  });
  return (
    <div className="fixed inset-0 z-70 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/40"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-corpus-title"
        className="relative w-full max-w-md space-y-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
      >
        <h2
          id="delete-corpus-title"
          className="text-base font-semibold text-slate-900"
        >
          Delete “{corpus.name}”?
        </h2>
        <p className="text-base text-slate-600">
          It holds {corpus.documentCount} page
          {corpus.documentCount === 1 ? "" : "s"}. Agents connected to it are
          disconnected. What should happen to the pages?
        </p>
        <fieldset className="space-y-3">
          <legend className="sr-only">What happens to its pages</legend>
          {PAGE_CHOICES.map((choice) => (
            <label key={choice.mode} className="flex items-start gap-2">
              <input
                type="radio"
                name="pages"
                className="mt-1"
                checked={pages === choice.mode}
                onChange={() => setPages(choice.mode)}
              />
              <span>
                <span className="block text-base font-medium text-slate-900">
                  {choice.label}
                </span>
                <span className="block text-sm text-slate-500">
                  {choice.detail}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {error !== undefined && (
          <p role="alert" className="text-base text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <Button
            ref={cancelRef}
            type="button"
            variant="secondary"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={pending}
            onClick={() => void run()}
          >
            {pending ? "Deleting…" : "Delete corpus"}
          </Button>
        </div>
      </div>
    </div>
  );
}
