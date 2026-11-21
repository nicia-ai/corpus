import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  imageAssetsExtension,
  type ImageAssets,
  resolveImageSource,
  setImageAssets,
} from "@/components/markdown/image-assets";
import {
  insertionMarkdown,
  linkTargetFor,
  nameForUpload,
  uploadableFiles,
} from "@/components/markdown/image-upload";
import {
  livePreview,
  livePreviewField,
  setEditorFocused,
} from "@/components/markdown/live-preview";
import type { AssetRef } from "@/store/domain/file-kinds";

// How an image destination resolves in the editor (loader-provided assets, no
// fetching), and what an upload turns into in the document.

const PNG: AssetRef = {
  url: "/api/files/p/aaaa",
  name: "shot.png",
  contentType: "image/png",
  size: 12,
};
const PDF: AssetRef = {
  url: "/api/files/p/bbbb",
  name: "spec.pdf",
  contentType: "application/pdf",
  size: 20,
};
const ASSETS: ImageAssets = { "./shot.png": PNG, "./spec.pdf": PDF };

describe("resolveImageSource", () => {
  it("passes an external URL through as written", () => {
    expect(resolveImageSource(ASSETS, "https://x.example/c.png")).toEqual({
      kind: "external",
      src: "https://x.example/c.png",
    });
    expect(resolveImageSource(ASSETS, "data:image/png;base64,AA")).toEqual({
      kind: "external",
      src: "data:image/png;base64,AA",
    });
  });

  it("resolves a relative target through the stored-file map only", () => {
    expect(resolveImageSource(ASSETS, "./shot.png")).toEqual({
      kind: "image",
      asset: PNG,
    });
    expect(resolveImageSource(ASSETS, "./spec.pdf")).toEqual({
      kind: "file",
      asset: PDF,
    });
  });

  it("is a named placeholder for a relative target nothing answers to", () => {
    expect(resolveImageSource(ASSETS, "./gone.png")).toEqual({
      kind: "missing",
      name: "gone.png",
    });
    expect(resolveImageSource({}, "../up/my%20pic.png#x")).toEqual({
      kind: "missing",
      name: "my pic.png",
    });
  });
});

type Spec = Readonly<{ widget?: { source?: { kind: string } } }>;

function imageKinds(doc: string, assets: ImageAssets): string[] {
  const state = EditorState.create({
    doc,
    selection: { anchor: 0 },
    extensions: [
      markdown({ base: markdownLanguage }),
      imageAssetsExtension(assets),
      livePreview(),
    ],
  }).update({ effects: setEditorFocused.of(true) }).state;
  const out: string[] = [];
  const it = state.field(livePreviewField).iter();
  while (it.value) {
    const widget = it.value.spec as Spec;
    if (widget.widget?.source !== undefined) {
      out.push(widget.widget.source.kind);
    }
    it.next();
  }
  return out;
}

describe("live preview resolves images from editor state", () => {
  const doc =
    "intro\n\n![a](./shot.png)\n\n![b](./gone.png)\n\n![c](https://x/c.png)";

  it("renders a stored image, a placeholder and an external image", () => {
    expect(imageKinds(doc, ASSETS)).toEqual(["image", "missing", "external"]);
  });

  it("re-resolves when the assets are replaced by effect (an upload landing)", () => {
    const base = EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [
        markdown({ base: markdownLanguage }),
        imageAssetsExtension({}),
        livePreview(),
      ],
    }).update({ effects: setEditorFocused.of(true) }).state;
    const kinds = (state: EditorState): string[] => {
      const out: string[] = [];
      const it = state.field(livePreviewField).iter();
      while (it.value) {
        const source = (it.value.spec as Spec).widget?.source;
        if (source !== undefined) out.push(source.kind);
        it.next();
      }
      return out;
    };
    expect(kinds(base)).toEqual(["missing", "missing", "external"]);
    const after = base.update({ effects: setImageAssets.of(ASSETS) }).state;
    expect(kinds(after)).toEqual(["image", "missing", "external"]);
  });
});

describe("what an upload becomes in the document", () => {
  it("links an image relative to the page, alt from the file name", () => {
    expect(linkTargetFor(PNG)).toBe("./shot.png");
    expect(insertionMarkdown(PNG)).toBe("![shot](./shot.png)");
  });

  it("links anything else as a plain link", () => {
    expect(insertionMarkdown(PDF)).toBe("[spec.pdf](./spec.pdf)");
  });

  it("omits the name of a pasted screenshot, which says nothing", () => {
    const shot = new File(["x"], "image.png", { type: "image/png" });
    const named = new File(["x"], "diagram.png", { type: "image/png" });
    expect(nameForUpload(shot, true)).toBeUndefined();
    expect(nameForUpload(shot, false)).toBe("image.png");
    expect(nameForUpload(named, true)).toBe("diagram.png");
  });

  it("offers only files worth sending", () => {
    const files = [
      new File(["x"], "a.png", { type: "image/png" }),
      new File(["x"], "b.exe", { type: "application/octet-stream" }),
      new File(["x"], "c.pdf", { type: "" }),
      new File(["x"], "d", { type: "image/webp" }),
    ];
    expect(uploadableFiles(files).map((f) => f.name)).toEqual([
      "a.png",
      "c.pdf",
      "d",
    ]);
  });
});
