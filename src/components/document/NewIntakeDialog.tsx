import { useNavigate } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";

import { Field } from "@/components/Field";
import { Button } from "@/components/ui/Button";
import { useDialogFocusTrap } from "@/components/ui/dialog-focus";
import { DialogFrame } from "@/components/ui/DialogFrame";
import { showToast } from "@/components/ui/Toast";
import { embassyPrompt } from "@/embassy/prompt";
import { embassyUrl } from "@/embassy/url";
import type { ProjectId } from "@/ids";
import { useSubmit } from "@/lib/forms";
import { createIntake } from "@/lib/server/embassies";
import { isBlank } from "@/util";

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
  const [title, setTitle] = useState("");
  const dialogRef = useDialogFocusTrap({
    open: true,
    onClose,
    initialFocus: cancelRef,
  });
  const { pending, error, run } = useSubmit(async () => {
    const r = await createIntake({ data: { projectId, title } });
    await navigator.clipboard.writeText(
      embassyPrompt({
        url: embassyUrl(window.location.origin, r.embassy.id),
        grant: "replace",
      }),
    );
    showToast("Prompt copied");
    onClose();
    await nav({
      to: "/p/$projectId/documents/$slug",
      params: { projectId, slug: r.slug },
    });
  });
  return (
    <DialogFrame
      titleId={titleId}
      title="New intake"
      onClose={onClose}
      dialogRef={dialogRef}
      widthClass="max-w-md"
    >
      <p className="mt-1 text-base text-slate-500">
        Creates an empty page and copies a prompt their agent can use to fill
        it.
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
        <Button disabled={pending || isBlank(title)} onClick={() => void run()}>
          Create and copy prompt
        </Button>
      </div>
    </DialogFrame>
  );
}
