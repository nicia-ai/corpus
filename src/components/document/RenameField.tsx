import { useState } from "react";

import { Field } from "@/components/Field";
import { Button } from "@/components/ui/Button";

// Inline metadata editor for a document's title or file name — both are
// head-only (no version/content change) when editing an existing document,
// and local-only (nothing saved yet) on the create page. Shared so both
// surfaces render identically. `hint` carries the filename-specific note
// that relative links keep resolving on an existing document.
export function RenameField({
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
        autoFocus
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
