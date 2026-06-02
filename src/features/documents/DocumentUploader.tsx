import { useRouter } from "@tanstack/react-router";
import { FolderUp, Upload } from "lucide-react";
import { useRef, useState } from "react";

import { fieldInputClass } from "@/components/Field";
import { Button } from "@/components/ui/Button";
import { cardClass, listSurface } from "@/components/ui/Surface";
import { asCollectionSlug, type CollectionSlug, type ProjectId } from "@/ids";
import { useSubmit } from "@/lib/forms";
import {
  type ImportAndLinkResult,
  importDocumentsAndLink,
} from "@/lib/server/folders";
import {
  type Collected,
  collectFromDataTransfer,
  collectFromFiles,
  commonRoot,
  dropHasFiles,
  reRoot,
} from "@/lib/upload/collect";
import type { ImportCollectionLink } from "@/project-store";

// The whole upload flow as one component, shared between the dedicated
// /import route (page mode, with a Done summary) and the Documents
// empty state (inline mode, where the route loader's re-render IS the
// success state — no Done needed). The caller owns the surrounding
// PageHeader so each surface frames the action with its own words.

const MAX_ENTRIES = 5000;

function defaultFolderName(): string {
  return `imported-${new Date().toISOString().slice(0, 10)}`;
}

export function DocumentUploader(
  props: Readonly<{
    projectId: ProjectId;
    collections: readonly Readonly<{ slug: CollectionSlug; name: string }>[];
    // page mode hands the result back so the route can render a Done
    // summary; inline mode is fire-and-forget — router.invalidate()
    // unmounts the empty state when the new documents land.
    onComplete?: (r: ImportAndLinkResult) => void;
  }>,
): React.ReactElement {
  const { projectId, collections, onComplete } = props;
  const router = useRouter();
  const [collected, setCollected] = useState<Collected | null>(null);
  const [dropError, setDropError] = useState<string>();
  const [folder, setFolder] = useState("");
  const [link, setLink] = useState<ImportCollectionLink>({ mode: "none" });
  const [dragging, setDragging] = useState(false);
  const filesRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);

  function ingest(c: Collected) {
    // A drop the browser handed us files for, but none were readable text
    // (e.g. only binaries) — surface the picker fallback.
    if (c.files.length === 0 && c.skipped.length === 0) {
      setDropError(
        "Couldn’t read any files from that drop. Use the Choose files or Choose folder buttons below.",
      );
      return;
    }
    setDropError(undefined);
    setCollected(c);
    setFolder(commonRoot(c.files) ?? defaultFolderName());
  }

  const { pending, error, run } = useSubmit(async () => {
    if (collected === null || collected.files.length === 0) return;
    const root = folder.trim();
    if (root === "") throw new Error("Choose a folder name for this upload.");
    const entries = reRoot(collected.files, root).map((f) => ({
      path: f.path,
      markdown: f.text,
    }));
    if (entries.length > MAX_ENTRIES) {
      throw new Error(
        `That’s ${entries.length} files — split it into uploads of ${MAX_ENTRIES} or fewer.`,
      );
    }
    const result = await importDocumentsAndLink({
      data: {
        projectId,
        entries,
        link:
          link.mode === "new" ? { mode: "new", name: link.name.trim() } : link,
      },
    });
    setCollected(null);
    await router.invalidate();
    onComplete?.(result);
  });

  return (
    <>
      <input
        ref={filesRef}
        type="file"
        multiple
        accept=".md,.markdown,.mdx,.txt,.zip"
        className="hidden"
        onChange={(e) => {
          const fs = e.target.files;
          if (fs && fs.length > 0) void collectFromFiles([...fs]).then(ingest);
          e.target.value = "";
        }}
      />
      <input
        ref={(el) => {
          dirRef.current = el;
          if (el) {
            el.setAttribute("webkitdirectory", "");
            el.setAttribute("directory", "");
          }
        }}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const fs = e.target.files;
          if (fs && fs.length > 0) void collectFromFiles([...fs]).then(ingest);
          e.target.value = "";
        }}
      />

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          // A drag from a code editor / app (VS Code, Cursor, …) carries
          // only string paths/URLs, never readable files — the browser
          // can't open `file://` paths. Detect that and point at a Finder
          // drag or the picker rather than failing opaquely.
          if (!dropHasFiles(e.dataTransfer)) {
            setDropError(
              "That drop didn’t include any files — dragging from a code editor or app only shares links, not the files. Drag from Finder, or use the Choose files / Choose folder buttons below.",
            );
            return;
          }
          void collectFromDataTransfer(e.dataTransfer).then(ingest);
        }}
        className={cardClass(
          `flex flex-col items-center gap-4 border-dashed py-12 text-center ${
            dragging ? "border-blue-600 bg-blue-50" : "border-slate-300"
          }`,
        )}
      >
        <Upload className="size-8 text-slate-400" aria-hidden />
        <p className="text-base text-slate-600">
          Drag a folder or files here, or
        </p>
        <div className="flex items-center gap-3">
          <Button onClick={() => filesRef.current?.click()}>
            Choose files
          </Button>
          <Button
            variant="secondary"
            onClick={() => dirRef.current?.click()}
            className="inline-flex items-center gap-1.5"
          >
            <FolderUp className="size-4" />
            Choose folder
          </Button>
        </div>
        {dropError !== undefined && (
          <p className="text-sm text-red-600">{dropError}</p>
        )}
      </div>

      {collected !== null && (
        <form
          className={cardClass("mt-6 space-y-5")}
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <Review collected={collected} />

          <div>
            <label
              htmlFor="folder"
              className="mb-1 block text-sm font-medium text-slate-700"
            >
              Import into folder
            </label>
            <input
              id="folder"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder={defaultFolderName()}
              className={fieldInputClass()}
            />
            <p className="mt-1 text-sm text-slate-500">
              Everything in this upload lands under one folder you can link to a
              collection.
            </p>
          </div>

          <LinkPicker
            collections={collections}
            value={link}
            onChange={setLink}
          />

          {error && <p className="text-base text-red-600">{error}</p>}
          <Button
            type="submit"
            disabled={pending || collected.files.length === 0}
          >
            {pending
              ? "Importing…"
              : `Import ${collected.files.length} document${
                  collected.files.length === 1 ? "" : "s"
                }`}
          </Button>
        </form>
      )}
    </>
  );
}

function Review({ collected }: Readonly<{ collected: Collected }>) {
  const { files, skipped } = collected;
  return (
    <div>
      <p className="text-base text-slate-700">
        <span className="font-medium">{files.length}</span> file
        {files.length === 1 ? "" : "s"} ready
        {skipped.length > 0 && (
          <>
            {" · "}
            <span className="text-amber-700">{skipped.length} skipped</span>
          </>
        )}
      </p>
      {files.length > 0 && (
        <ul
          className={listSurface(
            "mt-2 max-h-56 divide-y divide-slate-200 overflow-y-auto",
          )}
        >
          {files.map((f) => (
            <li
              key={f.path}
              className="px-3 py-1.5 font-mono text-sm text-slate-700"
            >
              {f.path}
            </li>
          ))}
        </ul>
      )}
      {skipped.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-slate-500">
            Show {skipped.length} skipped file
            {skipped.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {skipped.map((s) => (
              <li key={s.path} className="text-sm text-slate-500">
                <span className="font-mono">{s.path}</span> — {s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function LinkPicker({
  collections,
  value,
  onChange,
}: Readonly<{
  collections: readonly Readonly<{ slug: CollectionSlug; name: string }>[];
  value: ImportCollectionLink;
  onChange: (v: ImportCollectionLink) => void;
}>) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium text-slate-700">
        Link this upload to a collection
      </legend>
      <label className="flex items-center gap-2 text-base text-slate-700">
        <input
          type="radio"
          name="link"
          checked={value.mode === "none"}
          onChange={() => onChange({ mode: "none" })}
        />
        Don’t link now
      </label>
      <label className="flex items-center gap-2 text-base text-slate-700">
        <input
          type="radio"
          name="link"
          checked={value.mode === "new"}
          onChange={() => onChange({ mode: "new", name: "" })}
        />
        New collection
      </label>
      {value.mode === "new" && (
        <input
          autoFocus
          value={value.name}
          onChange={(e) => onChange({ mode: "new", name: e.target.value })}
          placeholder="Collection name"
          className={fieldInputClass("ml-6 w-[calc(100%-1.5rem)]")}
        />
      )}
      <label className="flex items-center gap-2 text-base text-slate-700">
        <input
          type="radio"
          name="link"
          disabled={collections.length === 0}
          checked={value.mode === "existing"}
          onChange={() =>
            onChange({
              mode: "existing",
              slug: collections[0]?.slug ?? asCollectionSlug(""),
            })
          }
        />
        Existing collection
        {collections.length === 0 && (
          <span className="text-sm text-slate-400">(none yet)</span>
        )}
      </label>
      {value.mode === "existing" && (
        <select
          value={value.slug}
          onChange={(e) =>
            onChange({
              mode: "existing",
              slug: asCollectionSlug(e.target.value),
            })
          }
          className={fieldInputClass("ml-6 w-[calc(100%-1.5rem)]")}
        >
          {collections.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
        </select>
      )}
      <p className="text-sm text-slate-500">
        Linking the folder is live: files added to it later are in the
        collection automatically.
      </p>
    </fieldset>
  );
}
