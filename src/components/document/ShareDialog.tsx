import { useId, useRef, useState } from "react";

import { Field, FieldLabel } from "@/components/Field";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { useDialogFocusTrap } from "@/components/ui/dialog-focus";
import { DialogFrame } from "@/components/ui/DialogFrame";
import { Segmented } from "@/components/ui/Segmented";
import { showToast } from "@/components/ui/Toast";
import type { EmbassyGrant } from "@/embassy/grant";
import { isIntakeMarkdown } from "@/embassy/intake";
import { embassyPrompt } from "@/embassy/prompt";
import { embassyUrl } from "@/embassy/url";
import type { DocumentSlug, ProjectId } from "@/ids";
import { useSubmit } from "@/lib/forms";
import {
  changeEmbassyGrant,
  createEmbassy,
  renameEmbassy,
  revokeEmbassy,
  unshareDocument,
  type EmbassyDto,
} from "@/lib/server/embassies";
import { isBlank } from "@/util";

const GRANT_OPTIONS = [
  { value: "read", label: "View" },
  { value: "suggest", label: "Suggest" },
  { value: "edit", label: "Edit" },
] as const satisfies readonly Readonly<{
  value: EmbassyGrant;
  label: string;
}>[];

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
  served,
  onClose,
}: Readonly<{
  projectId: ProjectId;
  slug: DocumentSlug;
  markdown: string;
  initialRows: readonly EmbassyDto[];
  served: boolean;
  onClose: () => void;
}>): React.ReactElement {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogFocusTrap({
    open: true,
    onClose,
    initialFocus: closeRef,
  });
  const [rows, setRows] = useState(initialRows);
  const [label, setLabel] = useState("");
  const [grant, setGrant] = useState<EmbassyGrant>(
    !served && isIntakeMarkdown(markdown) ? "edit" : "read",
  );
  const shared = rows.length > 0;

  const { pending, error, run } = useSubmit(async () => {
    const created = await createEmbassy({
      data: { projectId, slug, grant, label },
    });
    setRows((prev) => [created, ...prev]);
    setLabel("");
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
      {served && (
        <p className="mt-2 text-sm text-slate-600">
          This page is served by a corpus. Shared links can propose edits for
          review; direct editing is available while a draft is unserved.
        </p>
      )}
      <div className="mt-4">
        <Field
          label="Link name"
          value={label}
          onChange={setLabel}
          maxLength={80}
        />
      </div>
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
        {!served && (
          <label className="mt-1 block text-base text-slate-700">
            <input
              type="radio"
              className="mr-1.5"
              checked={grant === "edit"}
              onChange={() => setGrant("edit")}
            />
            Edit directly while unserved — switch to Suggest for review
          </label>
        )}
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
        <Button disabled={pending || isBlank(label)} onClick={() => void run()}>
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
              served={served}
              onChanged={(next) =>
                setRows((prev) =>
                  prev.map((r) => (r.id === next.id ? next : r)),
                )
              }
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
  served,
  onChanged,
  onRevoked,
}: Readonly<{
  row: EmbassyDto;
  projectId: ProjectId;
  served: boolean;
  onChanged: (next: EmbassyDto) => void;
  onRevoked: () => void;
}>): React.ReactElement {
  const { pending, run } = useSubmit(async () => {
    await revokeEmbassy({ data: { projectId, embassyId: row.id } });
    onRevoked();
  });
  const { error: grantError, run: runGrant } = useSubmit(
    async (next: EmbassyGrant) => {
      onChanged(
        await changeEmbassyGrant({
          data: { projectId, embassyId: row.id, grant: next },
        }),
      );
    },
  );
  const [label, setLabel] = useState(row.label);
  const {
    pending: renaming,
    error: renameError,
    run: runRename,
  } = useSubmit(async () => {
    onChanged(
      await renameEmbassy({ data: { projectId, embassyId: row.id, label } }),
    );
  });
  const url = embassyUrl(window.location.origin, row.id);
  return (
    <li className="text-sm text-slate-700">
      <div className="mb-2 flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field
            label="Link name"
            value={label}
            onChange={setLabel}
            maxLength={80}
          />
        </div>
        {label.trim() !== row.label && (
          <Button
            variant="secondary"
            disabled={renaming || isBlank(label)}
            onClick={() => void runRename()}
          >
            Save name
          </Button>
        )}
      </div>
      {renameError !== undefined && (
        <p className="mb-2 text-sm text-red-600">{renameError}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          ariaLabel="Link access"
          options={served ? GRANT_OPTIONS.slice(0, 2) : GRANT_OPTIONS}
          value={served && row.grant === "edit" ? "suggest" : row.grant}
          onChange={(next) => void runGrant(next)}
        />
        {served && row.grant === "edit" && (
          <span className="text-slate-600">Direct editing paused</span>
        )}
        <span className="text-slate-500 tabular-nums">
          {row.fetchCount} fetch{row.fetchCount === 1 ? "" : "es"}
        </span>
        <span className="text-slate-500 tabular-nums">
          until {new Date(row.expiresAt).toLocaleDateString()}
        </span>
      </div>
      {grantError !== undefined && (
        <p className="mt-1 text-sm text-red-600">{grantError}</p>
      )}
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
