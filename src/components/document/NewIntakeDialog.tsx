import { useNavigate, useRouter } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";

import { Field } from "@/components/Field";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { useDialogFocusTrap } from "@/components/ui/dialog-focus";
import { DialogFrame } from "@/components/ui/DialogFrame";
import { showToast } from "@/components/ui/Toast";
import { embassyPrompt } from "@/embassy/prompt";
import { embassyUrl } from "@/embassy/url";
import type { ProjectId } from "@/ids";
import { useSubmit } from "@/lib/forms";
import { createIntake } from "@/lib/server/embassies";
import { isBlank } from "@/util";

type CreatedIntake = Readonly<{ slug: string; prompt: string }>;

export function NewIntakeDialog({
  projectId,
  onClose,
}: Readonly<{
  projectId: ProjectId;
  onClose: () => void;
}>): React.ReactElement {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const nav = useNavigate();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [created, setCreated] = useState<CreatedIntake | undefined>(undefined);
  const dialogRef = useDialogFocusTrap({
    open: true,
    onClose,
    initialFocus: cancelRef,
  });
  async function openDocument(slug: string): Promise<void> {
    onClose();
    await nav({
      to: "/p/$projectId/documents/$slug",
      params: { projectId, slug },
    });
  }
  const { pending, error, run } = useSubmit(async () => {
    const r = await createIntake({ data: { projectId, title } });
    const prompt = embassyPrompt({
      url: embassyUrl(window.location.origin, r.embassy.id),
      grant: "edit",
    });
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      setCreated({ slug: r.slug, prompt });
      void router.invalidate();
      return;
    }
    showToast("Prompt copied");
    await openDocument(r.slug);
  });
  return (
    <DialogFrame
      titleId={titleId}
      title="New intake"
      onClose={onClose}
      dialogRef={dialogRef}
      widthClass="max-w-md"
    >
      {created === undefined ? (
        <>
          <p className="mt-1 text-base text-slate-500">
            Creates an empty page and copies a prompt an agent can use to write
            it. The agent keeps editing until you switch the link to review in
            Share.
          </p>
          <div className="mt-4">
            <Field label="Title" value={title} onChange={setTitle} autoFocus />
          </div>
          {error !== undefined && (
            <p className="mt-2 text-sm text-red-600">{error}</p>
          )}
          <div className="mt-5 flex justify-end gap-3">
            <Button ref={cancelRef} variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={pending || isBlank(title)}
              onClick={() => void run()}
            >
              Create and copy prompt
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 text-base text-slate-500">
            Created. The prompt could not be copied — copy it below, then open
            the page.
          </p>
          <div className="mt-4 flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 p-2">
            <pre className="max-h-40 min-w-0 flex-1 overflow-auto whitespace-pre-wrap font-mono text-sm text-slate-700">
              {created.prompt}
            </pre>
            <CopyButton value={created.prompt} label="Copy prompt" />
          </div>
          <div className="mt-5 flex justify-end gap-3">
            <Button ref={cancelRef} variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button onClick={() => void openDocument(created.slug)}>
              Open document
            </Button>
          </div>
        </>
      )}
    </DialogFrame>
  );
}
