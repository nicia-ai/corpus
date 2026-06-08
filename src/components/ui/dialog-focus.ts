// Candidate-tabbable selector — `:not()` filters cover the hidden-element
// classes querySelectorAll otherwise returns (aria-hidden subtrees, disabled
// controls, descendants of a disabled fieldset, and negative-tabindex nodes).
// The `display:none` / `visibility:hidden` case is caught by `offsetParent`.
const FOCUSABLE_SELECTOR =
  'a[href]:not([aria-hidden="true"]), button:not([disabled]):not([aria-hidden="true"]), input:not([disabled]):not([aria-hidden="true"]), select:not([disabled]):not([aria-hidden="true"]), textarea:not([disabled]):not([aria-hidden="true"]), [tabindex]:not([tabindex="-1"]):not([aria-hidden="true"])';

export function focusableIn(root: HTMLElement): readonly HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => el.offsetParent !== null && !el.closest("fieldset[disabled]"),
  );
}
