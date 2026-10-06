import {
  Bold,
  Code,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link,
  Strikethrough,
} from "lucide-react";

import { modKeyLabel } from "@/lib/platform";

export type AuthoringAction =
  | "bold"
  | "italic"
  | "strike"
  | "inline-code"
  | "link"
  | "indent"
  | "outdent"
  | "paragraph"
  | "heading"
  | "quote"
  | "bullet"
  | "ordered"
  | "task"
  | "code"
  | "table";

const FORMATTING = [
  { action: "bold", label: "Bold", key: "B", Icon: Bold },
  { action: "italic", label: "Italic", key: "I", Icon: Italic },
  {
    action: "strike",
    label: "Strikethrough",
    key: "Shift+X",
    Icon: Strikethrough,
  },
  { action: "inline-code", label: "Inline code", key: "Shift+C", Icon: Code },
  { action: "link", label: "Insert or edit link", key: "K", Icon: Link },
  { action: "outdent", label: "Outdent", key: "[", Icon: IndentDecrease },
  { action: "indent", label: "Indent", key: "]", Icon: IndentIncrease },
] as const;

const BLOCKS = [
  { action: "paragraph", label: "Paragraph" },
  { action: "heading", label: "Heading" },
  { action: "quote", label: "Quote" },
  { action: "bullet", label: "Bullet list" },
  { action: "ordered", label: "Numbered list" },
  { action: "task", label: "Task list" },
  { action: "code", label: "Code block" },
  { action: "table", label: "Table" },
] as const;

const CONTROL =
  "min-h-11 rounded-md px-3 text-sm text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50";

export function EditorControls({
  disabled,
  sourceMode,
  onAction,
  onToggleSource,
}: Readonly<{
  disabled: boolean;
  sourceMode: boolean;
  onAction: (action: AuthoringAction) => void;
  onToggleSource: () => void;
}>): React.ReactElement {
  // Keep SSR and the first hydration render identical, then use platform labels.
  const mod = disabled ? "Ctrl" : modKeyLabel();
  return (
    <div className="mb-4 border-b border-slate-200 pb-2">
      <div
        role="group"
        aria-label="Markdown editing controls"
        className="flex flex-wrap items-center gap-1"
      >
        {FORMATTING.map(({ action, label, key, Icon }) => (
          <button
            key={action}
            type="button"
            disabled={disabled}
            className={`${CONTROL} inline-flex size-11 items-center justify-center px-0`}
            aria-label={label}
            title={`${label} (${mod}+${key})`}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => onAction(action)}
          >
            <Icon size={18} aria-hidden="true" />
          </button>
        ))}
        <select
          aria-label="Insert or change block"
          className={`${CONTROL} bg-transparent`}
          disabled={disabled}
          value=""
          onChange={(event) => {
            const item = BLOCKS.find(
              (block) => block.action === event.target.value,
            );
            if (item !== undefined) onAction(item.action);
          }}
        >
          <option value="" disabled>
            Insert / change…
          </option>
          {BLOCKS.map(({ action, label }) => (
            <option key={action} value={action}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={disabled}
          className={`${CONTROL} ml-auto`}
          aria-pressed={sourceMode}
          title="Show all Markdown syntax"
          onClick={onToggleSource}
        >
          Source
        </button>
      </div>
      <details className="text-sm text-slate-500">
        <summary className="min-h-11 cursor-pointer content-center rounded-md px-3 focus-visible:outline-2 focus-visible:outline-blue-600">
          Keyboard shortcuts
        </summary>
        <p className="px-3 pb-2">
          {mod}+B bold · {mod}+I italic · {mod}+K link · {mod}+Shift+C inline
          code · {mod}+Shift+X strikethrough · {mod}+[ / ] outdent / indent. Tab
          / Shift+Tab nests lists and indents code. Press Escape, then Tab to
          leave the editor. Enter continues a list; Enter on an empty item exits
          it. {mod}+Z undoes an action.
        </p>
      </details>
    </div>
  );
}
