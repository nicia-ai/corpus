import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Surface";
import { useSubmit } from "@/lib/forms";

// The inline Comment / Suggest popover, rendered over the editor selection. It
// owns only its own form state; the host supplies the selected quote, the
// source slice to seed a suggestion, and the two submit actions (which return
// an error message or undefined). Extracted from the old rendered review view so
// the editor surface reuses the exact same composer.

type Mode = "menu" | "comment" | "suggest";

const TEXTAREA_CLASS =
  "w-full rounded-md border border-slate-300 px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";

export function ReviewComposer({
  quote,
  initialSuggest,
  canComment,
  commentMinChars,
  onComment,
  onSuggest,
  onCancel,
}: Readonly<{
  quote: string;
  initialSuggest: string;
  canComment: boolean;
  // The server's minimum quote length; a shorter selection can still open the
  // composer but can't submit — shown as an inline hint, not a post-submit error.
  commentMinChars: number;
  onComment: (body: string) => Promise<string | undefined>;
  onSuggest: (edited: string) => Promise<string | undefined>;
  onCancel: () => void;
}>): React.ReactElement {
  const [mode, setMode] = useState<Mode>("menu");
  const [body, setBody] = useState("");
  const [edited, setEdited] = useState(initialSuggest);

  const {
    pending: commenting,
    error: commentError,
    run: comment,
  } = useSubmit(async () => {
    const text = body.trim();
    if (text === "") return;
    const message = await onComment(text);
    if (message !== undefined) throw new Error(message);
    onCancel();
  });

  const {
    pending: suggesting,
    error: suggestError,
    run: suggest,
  } = useSubmit(async () => {
    if (edited.trim() === "") return;
    const message = await onSuggest(edited);
    if (message !== undefined) throw new Error(message);
    onCancel();
  });

  function onKeyDown(
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    submit: () => void,
    disabled: boolean,
  ): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    if (!disabled) submit();
  }

  if (mode === "menu") {
    return (
      <div className="flex gap-1 rounded-md border border-slate-200 bg-white p-1 shadow-sm">
        {canComment && (
          <PopoverAction onClick={() => setMode("comment")} label="Comment" />
        )}
        <PopoverAction
          onClick={() => setMode("suggest")}
          label="Suggest edit"
        />
      </div>
    );
  }

  if (mode === "comment") {
    // Too short to anchor a comment: guide instead of opening a dead text field
    // (an error-styled hint over a comment box reads as if the comment body is
    // wrong, when it's the selection that's too short).
    if (quote.length < commentMinChars) {
      return (
        <Card className="w-72 space-y-2 p-3 shadow-md">
          <Quote text={quote} />
          <p className="text-sm text-slate-500">
            Select at least {commentMinChars} characters to comment.
          </p>
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </Card>
      );
    }
    const disabled = commenting || body.trim() === "";
    return (
      <Card className="w-72 space-y-2 p-3 shadow-md">
        <Quote text={quote} />
        <textarea
          autoFocus
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => onKeyDown(e, () => void comment(), disabled)}
          rows={3}
          placeholder="Add a comment..."
          className={`${TEXTAREA_CLASS} text-base`}
        />
        <Actions
          submitLabel="Comment"
          disabled={disabled}
          onSubmit={() => void comment()}
          onCancel={onCancel}
          error={commentError}
        />
      </Card>
    );
  }

  const disabled = suggesting || edited.trim() === "";
  return (
    <Card className="w-80 space-y-2 p-3 shadow-md">
      <div className="text-sm text-slate-500">Propose an edit</div>
      <textarea
        autoFocus
        value={edited}
        onChange={(e) => setEdited(e.target.value)}
        onKeyDown={(e) => onKeyDown(e, () => void suggest(), disabled)}
        rows={4}
        className={`${TEXTAREA_CLASS} font-mono text-sm`}
      />
      <Actions
        submitLabel="Suggest"
        disabled={disabled}
        onSubmit={() => void suggest()}
        onCancel={onCancel}
        error={suggestError}
      />
    </Card>
  );
}

function PopoverAction({
  onClick,
  label,
}: Readonly<{ onClick: () => void; label: string }>): React.ReactElement {
  return (
    <button
      type="button"
      // Keep the editor selection alive: a plain mousedown would blur/clear it
      // before the click handler opens the composer.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="rounded-sm px-2 py-1 text-sm font-medium text-blue-600 hover:bg-slate-50"
    >
      {label}
    </button>
  );
}

function Quote({ text }: Readonly<{ text: string }>): React.ReactElement {
  return (
    <div className="line-clamp-2 border-l-2 border-slate-200 pl-2 text-sm text-slate-500">
      {text}
    </div>
  );
}

function Actions({
  submitLabel,
  disabled,
  onSubmit,
  onCancel,
  error,
}: Readonly<{
  submitLabel: string;
  disabled: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  error: string | undefined;
}>): React.ReactElement {
  return (
    <div className="flex items-center gap-2">
      <Button type="button" disabled={disabled} onClick={onSubmit}>
        {submitLabel}
      </Button>
      <Button type="button" variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      {error !== undefined && (
        <span className="text-sm text-red-600">{error}</span>
      )}
    </div>
  );
}
