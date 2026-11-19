import { useId, useState } from "react";

import { Field } from "@/components/Field";
import { Button } from "@/components/ui/Button";

import {
  type LinkDraft,
  type LinkInput,
  linkInputSchema,
} from "./authoring-commands";

export function LinkEditor({
  draft,
  onApply,
  onClose,
}: Readonly<{
  draft: LinkDraft;
  onApply: (input: LinkInput) => void;
  onClose: (focusEditor: boolean) => void;
}>): React.ReactElement {
  const [text, setText] = useState(draft.text);
  const [href, setHref] = useState(draft.href);
  const [error, setError] = useState<string>();
  const hintId = useId();
  const errorId = useId();
  const title = draft.existing === undefined ? "Insert link" : "Edit link";

  function apply(): void {
    const parsed = linkInputSchema.safeParse({ text, href });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }
    onApply(parsed.data);
  }

  // The editor also appears inside the new-document form. Keep this a
  // nonmodal panel, not a nested form or a page-level submit action.
  return (
    <div
      role="dialog"
      aria-label={title}
      className="absolute inset-x-0 top-full z-20 max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-4"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onClose(false);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose(true);
        } else if (
          event.key === "Enter" &&
          event.target instanceof HTMLInputElement
        ) {
          event.preventDefault();
          event.stopPropagation();
          apply();
        }
      }}
    >
      <h2 className="text-base font-medium text-slate-900">{title}</h2>
      <Field
        label="Link text"
        value={text}
        onChange={setText}
        autoFocus={draft.text === ""}
      />
      <Field
        label="Destination"
        value={href}
        onChange={setHref}
        autoFocus={draft.text !== ""}
        ariaDescribedBy={error === undefined ? hintId : `${hintId} ${errorId}`}
      />
      <p id={hintId} className="text-sm text-slate-600">
        Use a web address, document path, or #section.
      </p>
      {error !== undefined && (
        <p id={errorId} role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => onClose(true)}>
          Cancel
        </Button>
        <Button onClick={apply}>
          {draft.existing === undefined ? "Insert link" : "Apply"}
        </Button>
      </div>
    </div>
  );
}
