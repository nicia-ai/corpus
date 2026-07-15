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
    ariaDescribedBy?: string | undefined;
  }>,
): React.ReactElement {
  const required = props.required ?? true;
  return (
    <label className="block">
      <FieldLabel>{props.label}</FieldLabel>
      {props.as === "textarea" ? (
        <textarea
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
