import { Folder as FolderIcon } from "lucide-react";
import { useState } from "react";

import { fieldInputClass } from "@/components/Field";
import { treeIndent } from "@/lib/tree";

// Inline new-folder row — blurring with empty input cancels, submitting
// with a trimmed name creates. Parent owns expansion state so a newly
// created folder is auto-expanded.
export function NewFolder({
  depth,
  onCreate,
  onCancel,
}: Readonly<{
  depth: number;
  onCreate: (name: string) => Promise<void>;
  onCancel: () => void;
}>): React.ReactElement {
  const [name, setName] = useState("");
  return (
    <form
      style={treeIndent(depth)}
      className="flex items-center gap-2 py-2 pr-3"
      onSubmit={(e) => {
        e.preventDefault();
        const v = name.trim();
        if (v === "") {
          onCancel();
          return;
        }
        void onCreate(v);
      }}
    >
      <FolderIcon className="size-4 shrink-0 text-slate-400" aria-hidden />
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          if (name.trim() === "") onCancel();
        }}
        placeholder="New folder name"
        className={fieldInputClass("py-1!")}
      />
    </form>
  );
}
