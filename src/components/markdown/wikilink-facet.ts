import { Facet } from "@codemirror/state";

import type { WikiResolve } from "./inline-spans";

// Wikilink resolution as editor state: target text → document slug, or
// undefined when nothing in the project matches. Provided by the host
// (MarkdownEditor builds it from the project's document paths) and read
// by both the live-preview decorator and the table widget — a separate
// module because live-preview imports block-widgets, so neither can own
// a value the other needs.
export const wikiLinkResolver = Facet.define<
  WikiResolve,
  WikiResolve | undefined
>({
  combine: (values) => values[0],
});
