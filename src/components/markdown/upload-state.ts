import {
  type EditorState,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";

import { blockInsertion } from "./image-upload";

// An upload in flight, shown where its link will land. Nothing is written to
// the document until the server has accepted the file: the pending marker is
// editor state with a position that follows the text as it is edited around
// it, and it becomes real markdown (or vanishes) when the upload settles.
// So a failed upload inserts nothing, and a half-finished one is never saved.

type PendingUpload = Readonly<{ id: number; pos: number; label: string }>;

const startedUpload = StateEffect.define<PendingUpload>();
const settledUpload = StateEffect.define<number>();

class UploadingWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  override eq(other: UploadingWidget): boolean {
    return other.label === this.label;
  }
  override toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className =
      "mx-0.5 inline-flex items-center rounded-md border border-slate-200 bg-slate-100 px-2 text-sm text-slate-500";
    el.setAttribute("role", "status");
    el.textContent = `Uploading ${this.label}…`;
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

function pendingDecorations(list: readonly PendingUpload[]): DecorationSet {
  return Decoration.set(
    list.map((p) =>
      Decoration.widget({
        widget: new UploadingWidget(p.label),
        side: 1,
      }).range(p.pos),
    ),
    true,
  );
}

const pendingField = StateField.define<readonly PendingUpload[]>({
  create: () => [],
  update(value, tr: Transaction) {
    let next = tr.docChanged
      ? value.map((p) => ({ ...p, pos: tr.changes.mapPos(p.pos, 1) }))
      : value;
    for (const effect of tr.effects) {
      if (effect.is(startedUpload)) next = [...next, effect.value];
      if (effect.is(settledUpload)) {
        next = next.filter((p) => p.id !== effect.value);
      }
    }
    return next;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (list) => pendingDecorations(list)),
});

export const uploadStateExtension = pendingField;

let nextUploadId = 1;

// Show "Uploading <label>…" at `pos` and return the handle to settle it.
export function startUpload(
  view: EditorView,
  pos: number,
  label: string,
): number {
  const id = nextUploadId++;
  view.dispatch({ effects: startedUpload.of({ id, pos, label }) });
  return id;
}

function positionOf(state: EditorState, id: number): number | undefined {
  return state.field(pendingField, false)?.find((p) => p.id === id)?.pos;
}

// The upload succeeded: replace its marker with `markdown` as its own block
// (see `blockInsertion`), one transaction, so undo removes the link and the
// image appears in the same step. The extra effects (the new asset) ride along.
export function finishUpload(
  view: EditorView,
  id: number,
  markdown: string,
  effects: readonly StateEffect<unknown>[],
): void {
  const pos = positionOf(view.state, id);
  const block =
    pos === undefined
      ? undefined
      : blockInsertion(view.state.doc, pos, markdown);
  view.dispatch({
    ...(block === undefined
      ? {}
      : {
          changes: { from: block.at, insert: block.insert },
          selection: { anchor: block.caret },
        }),
    effects: [settledUpload.of(id), ...effects],
  });
}

// The upload failed: the marker goes, the document is untouched.
export function failUpload(view: EditorView, id: number): void {
  view.dispatch({ effects: settledUpload.of(id) });
}
