import { useId, useRef, useState } from "react";

import { FieldLabel } from "@/components/Field";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { useDialogFocusTrap } from "@/components/ui/dialog-focus";
import { DialogFrame } from "@/components/ui/DialogFrame";
import { showToast } from "@/components/ui/Toast";
import type { EmbassyGrant } from "@/embassy/grant";
import { isIntakeMarkdown } from "@/embassy/intake";
import { embassyPrompt } from "@/embassy/prompt";
import { embassyUrl } from "@/embassy/url";
import type { DocumentSlug, ProjectId } from "@/ids";
import { useSubmit } from "@/lib/forms";
import {
  createEmbassy,
  revokeEmbassy,
  unshareDocument,
  type EmbassyDto,
} from "@/lib/server/embassies";

function grantLabel(grant: EmbassyGrant): string {
  if (grant === "read") return "View only";
  if (grant === "replace") return "Can fill this page";
  return "Can suggest edits";
}

async function copyWithToast(
  input: Readonly<{
    value: string;
    successMessage: string;
    failureMessage: string;
  }>,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(input.value);
    showToast(input.successMessage);
  } catch {
    showToast(input.failureMessage);
  }
}

export function ShareDialog({
  projectId,
  slug,
  markdown,
  initialRows,
  onClose,
}: Readonly<{
  projectId: ProjectId;
  slug: DocumentSlug;
  markdown: string;
  initialRows: readonly EmbassyDto[];
  onClose: () => void;
}>): React.ReactElement {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogFocusTrap({
    open: true,
    onClose,
    initialFocus: closeRef,
  });
  const intake = isIntakeMarkdown(markdown);
  const [rows, setRows] = useState(initialRows);
  const [grant, setGrant] = useState<EmbassyGrant>("read");
  const shared = rows.length > 0;

  const { pending, error, run } = useSubmit(async () => {
    const created = await createEmbassy({
      data: { projectId, slug, grant },
    });
    setRows((prev) => [created, ...prev]);
    showToast("Link created");
  });

  const { pending: unsharing, run: runUnshare } = useSubmit(async () => {
    const ok = await confirmDialog({
      title: "Stop sharing this page?",
      body: "Everyone with a link will lose access.",
      confirmLabel: "Unshare",
      tone: "danger",
    });
    if (!ok) return;
    await unshareDocument({ data: { projectId, slug } });
    setRows([]);
    showToast("Sharing stopped");
  });

  return (
    <DialogFrame
      titleId={titleId}
      title="Share"
      onClose={onClose}
      dialogRef={dialogRef}
    >
      <p className="mt-1 text-base text-slate-500">
        {shared
          ? "People with a link can read this page without joining the organization. Links expire in 7 days."
          : "This page is not shared. Create a link to let someone outside the organization read it."}
      </p>
      <fieldset className="mt-4">
        <legend>
          <FieldLabel>Access</FieldLabel>
        </legend>
        <label className="block text-base text-slate-700">
          <input
            type="radio"
            className="mr-1.5"
            checked={grant === "read"}
            onChange={() => setGrant("read")}
          />
          View only
        </label>
        <label className="mt-1 block text-base text-slate-700">
          <input
            type="radio"
            className="mr-1.5"
            checked={grant === "suggest"}
            onChange={() => setGrant("suggest")}
          />
          Suggest edits
        </label>
        <label className="mt-1 block text-base text-slate-700">
          <input
            type="radio"
            className="mr-1.5"
            checked={grant === "replace"}
            disabled={!intake}
            onChange={() => setGrant("replace")}
          />
          Fill this page{intake ? "" : " — for empty intake pages only"}
        </label>
      </fieldset>
      {error !== undefined && (
        <p className="mt-2 text-sm text-red-600">{error}</p>
      )}
      <div className="mt-5 flex justify-end gap-3">
        <Button ref={closeRef} variant="secondary" onClick={onClose}>
          Close
        </Button>
        {shared && (
          <Button
            variant="danger"
            disabled={unsharing}
            onClick={() => void runUnshare()}
          >
            Unshare
          </Button>
        )}
        <Button disabled={pending} onClick={() => void run()}>
          {shared ? "Create another link" : "Create link"}
        </Button>
      </div>
      {shared && (
        <ul className="mt-5 space-y-3 border-t border-slate-200 pt-4">
          {rows.map((row) => (
            <EmbassyRow
              key={row.id}
              row={row}
              projectId={projectId}
              onRevoked={() =>
                setRows((prev) => prev.filter((r) => r.id !== row.id))
              }
            />
          ))}
        </ul>
      )}
    </DialogFrame>
  );
}

function EmbassyRow({
  row,
  projectId,
  onRevoked,
}: Readonly<{
  row: EmbassyDto;
  projectId: ProjectId;
  onRevoked: () => void;
}>): React.ReactElement {
  const { pending, run } = useSubmit(async () => {
    await revokeEmbassy({ data: { projectId, embassyId: row.id } });
    onRevoked();
  });
  const url = embassyUrl(window.location.origin, row.id);
  return (
    <li className="text-sm text-slate-700">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{grantLabel(row.grant)}</span>
        <span className="text-slate-500 tabular-nums">
          {row.fetchCount} fetch{row.fetchCount === 1 ? "" : "es"}
        </span>
        <span className="text-slate-500 tabular-nums">
          until {new Date(row.expiresAt).toLocaleDateString()}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            void copyWithToast({
              value: embassyPrompt({ url, grant: row.grant }),
              successMessage: "Prompt copied",
              failureMessage: "Could not copy prompt",
            });
          }}
        >
          Copy prompt
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            void copyWithToast({
              value: url,
              successMessage: "Link copied",
              failureMessage: "Could not copy link",
            });
          }}
        >
          Copy link
        </Button>
        <Button variant="danger" disabled={pending} onClick={() => void run()}>
          Revoke
        </Button>
      </div>
    </li>
  );
}
