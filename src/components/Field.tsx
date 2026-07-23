import { useCallback } from "react";

import { cn } from "@/lib/cn";

// The one input surface (DESIGN.md: slate-300 border, blue focus ring).
// `fieldInputClass` is the shared style so the few label-less inputs
// (aria-label + placeholder) match without duplicating the string; `Field`
// is the labeled form-row used everywhere else, input or textarea.
export function fieldInputClass(className?: string): string {
  return cn(
    "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base focus:border-blue-600 focus:outline-2 focus:outline-blue-600",
    className,
  );
}

// The form-row caption. Shared so label-less controls (e.g. the CodeMirror
// MarkdownEditor, which isn't a labelable element) match `Field`'s typography
// without copying the class string.
export function FieldLabel(
  props: Readonly<{ children: React.ReactNode }>,
): React.ReactElement {
  return (
    <span className="mb-1 block text-sm font-medium text-slate-700">
      {props.children}
    </span>
  );
}

export function Field(
  props: Readonly<{
    label: string;
    value: string;
    onChange: (v: string) => void;
    type?: string;
    as?: "input" | "textarea";
    rows?: number;
    maxLength?: number;
    required?: boolean;
    mono?: boolean;
    autoFocus?: boolean;
    ariaDescribedBy?: string | undefined;
  }>,
): React.ReactElement {
  const required = props.required ?? true;
  // Stable callback ref (empty deps): fires once when the field mounts, so an
  // inline rename opens with the caret in the field and the current value
  // selected (type-to-replace). Attached only when `autoFocus` is set, so the
  // guard lives at the attachment site, not inside the ref.
  const focusAndSelect = useCallback(
    (el: HTMLInputElement | HTMLTextAreaElement | null) => {
      el?.focus();
      el?.select();
    },
    [],
  );
  const autoFocusRef = props.autoFocus === true ? focusAndSelect : undefined;
  return (
    <label className="block">
      <FieldLabel>{props.label}</FieldLabel>
      {props.as === "textarea" ? (
        <textarea
          ref={autoFocusRef}
          required={required}
          rows={props.rows ?? 12}
          maxLength={props.maxLength}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          aria-describedby={props.ariaDescribedBy}
          className={fieldInputClass(
            props.mono === true ? "font-mono" : undefined,
          )}
        />
      ) : (
        <input
          ref={autoFocusRef}
          type={props.type ?? "text"}
          required={required}
          maxLength={props.maxLength}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          aria-describedby={props.ariaDescribedBy}
          className={fieldInputClass()}
        />
      )}
    </label>
  );
}
