import { type EditorState, StateEffect, StateField } from "@codemirror/state";

import { isImageContentType, type AssetRef } from "@/store/domain/file-kinds";
import { isRelativeTarget } from "@/store/domain/links";

// The stored files an editor can render, by link target exactly as the
// markdown writes it (`./diagram.png`). The route loader supplies it
// (`getDocumentReview` → `assets`); an upload adds to it locally so the new
// image shows at once. It is editor STATE, not fetched data: nothing here
// reaches for the network, and a target the map does not hold is a missing
// image, never a request.
export type ImageAssets = Readonly<Record<string, AssetRef>>;

export const setImageAssets = StateEffect.define<ImageAssets>();

const imageAssetsField = StateField.define<ImageAssets>({
  create: () => ({}),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setImageAssets)) return effect.value;
    }
    return value;
  },
});

// The extension that seeds the field with the loader's assets at mount.
export function imageAssetsExtension(initial: ImageAssets) {
  return imageAssetsField.init(() => initial);
}

// The map in an editor state; empty where the extension is not installed.
export function assetsOf(state: EditorState): ImageAssets {
  return state.field(imageAssetsField, false) ?? {};
}

export { imageAssetsField };

// How an image destination renders:
//  - `external`: a URL (any scheme, protocol-relative, `data:`): as written;
//  - `image`: a relative target that is a stored image: its app URL;
//  - `file`: a relative target that is a stored non-image (a PDF): a link;
//  - `missing`: a relative target no stored file answers to: a placeholder.
export type ImageSource =
  | Readonly<{ kind: "external"; src: string }>
  | Readonly<{ kind: "image"; asset: AssetRef }>
  | Readonly<{ kind: "file"; asset: AssetRef }>
  | Readonly<{ kind: "missing"; name: string }>;

export function resolveImageSource(
  assets: ImageAssets,
  src: string,
): ImageSource {
  if (!isRelativeTarget(src)) return { kind: "external", src };
  const asset = assets[src];
  if (asset === undefined) return { kind: "missing", name: displayName(src) };
  return isImageContentType(asset.contentType)
    ? { kind: "image", asset }
    : { kind: "file", asset };
}

function displayName(src: string): string {
  const bare = src.replace(/[?#].*$/u, "");
  const name = bare.split("/").pop() ?? bare;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

// A stable string for widget equality: two renders of the same destination
// against the same resolution are the same DOM.
export function sourceKey(source: ImageSource): string {
  switch (source.kind) {
    case "external":
      return `external:${source.src}`;
    case "missing":
      return `missing:${source.name}`;
    case "image":
    case "file":
      return `${source.kind}:${source.asset.url}`;
  }
}
