import type { MarkdownEditorHandle } from "@/components/markdown/MarkdownEditor";
import { textLinkClass } from "@/components/ui/text-link";

// The subline affordance shown when a document has no frontmatter yet: seeds a
// metadata fence into the editor via the imperative handle. Callers own the
// "no frontmatter" guard (the edit surface tracks it as state, the create
// route derives it from its controlled value); this is only the button, so the
// label + wiring stay in one place across both surfaces.
export function AddMetadataButton({
  editorRef,
}: Readonly<{
  editorRef: React.RefObject<MarkdownEditorHandle | null>;
}>): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => editorRef.current?.addFrontmatter()}
      className={textLinkClass("text-sm")}
    >
      Add metadata
    </button>
  );
}
