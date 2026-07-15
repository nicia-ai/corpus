import { useRouter } from "@tanstack/react-router";
import { FolderUp, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { fieldInputClass } from "@/components/Field";
import { Button } from "@/components/ui/Button";
import { cardClass, listSurface } from "@/components/ui/Surface";
import {
  asCollectionSlug,
  asFolderSlug,
  type CollectionSlug,
  type FolderSlug,
  type ProjectId,
} from "@/ids";
import { useSubmit } from "@/lib/forms";
import type { DocListItem } from "@/lib/server/documents";
import {
  type FolderRow,
  type ImportAndLinkResult,
  importDocumentsAndLink,
} from "@/lib/server/folders";
import {
  type Collected,
  type CollectedFile,
  collectFromDataTransfer,
  collectFromFiles,
  commonRoot,
  dropHasFiles,
  placeEntries,
} from "@/lib/upload/collect";
import type { ImportCollectionLink } from "@/project-store";

// The whole upload flow as one component, shared between the dedicated
// /import route (page mode, with a Done summary) and the Documents
// empty state (inline mode, where the route loader's re-render IS the
// success state — no Done needed). The caller owns the surrounding
// PageHeader so each surface frames the action with its own words.

const MAX_ENTRIES = 5000;
const ROOT = "" as const;

type FolderIndex = ReadonlyMap<FolderSlug, FolderRow>;

function indexFolders(folders: readonly FolderRow[]): FolderIndex {
  return new Map(folders.map((f) => [f.slug, f]));
}

// Ancestor folder NAMES (root → leaf) for a folder slug; `[]` for the
// project root. The names are what the importer resolves folders by.
function folderNamePath(index: FolderIndex, slug: FolderSlug | null): string[] {
  const out: string[] = [];
  const seen = new Set<FolderSlug>();
  for (let cur = slug; cur !== null && !seen.has(cur);) {
    const f = index.get(cur);
    if (f === undefined) break;
    seen.add(cur);
    out.unshift(f.name);
    cur = f.parentSlug;
  }
  return out;
}

// Does a folder already live at this name-path? Cosmetic only — it
// predicts the link copy ("live folder" vs "documents"); the DO derives
// the real link target from what the import created, so a stale snapshot
// here can only mislabel a hint, never the actual link.
function folderExistsAtPath(
  index: FolderIndex,
  segments: readonly string[],
): boolean {
  if (segments.length === 0) return false;
  let parent: FolderSlug | null = null;
  for (const name of segments) {
    const hit = [...index.values()].find(
      (f) => f.parentSlug === parent && f.name === name,
    );
    if (hit === undefined) return false;
    parent = hit.slug;
  }
  return true;
}

function folderOptions(
  index: FolderIndex,
): readonly Readonly<{ slug: FolderSlug; label: string }>[] {
  return [...index.values()]
    .map((f) => ({
      slug: f.slug,
      label: folderNamePath(index, f.slug).join(" / "),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function DocumentUploader(
  props: Readonly<{
    projectId: ProjectId;
    collections: readonly Readonly<{ slug: CollectionSlug; name: string }>[];
    folders: readonly FolderRow[];
    documents: readonly DocListItem[];
    // page mode hands the result back so the route can render a Done
    // summary; inline mode is fire-and-forget — router.invalidate()
    // unmounts the empty state when the new documents land.
    onComplete?: (r: ImportAndLinkResult) => void;
  }>,
): React.ReactElement {
  const { projectId, collections, folders, documents, onComplete } = props;
  const router = useRouter();
  const [collected, setCollected] = useState<Collected | null>(null);
  const [dropError, setDropError] = useState<string>();
  const [destParent, setDestParent] = useState<FolderSlug | null>(null);
  const [makeNew, setMakeNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [keepWrapper, setKeepWrapper] = useState(true);
  const [link, setLink] = useState<ImportCollectionLink>({ mode: "none" });
  const [dragging, setDragging] = useState(false);
  const filesRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);

  // A fresh drop is a fresh upload: clear the destination + link choices
  // so the previous upload's selections never silently carry over.
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
    setDestParent(null);
    setMakeNew(false);
    setNewName("");
    setKeepWrapper(true);
    setLink({ mode: "none" });
    setCollected(c);
  }

  const index = useMemo(() => indexFolders(folders), [folders]);
  const options = useMemo(() => folderOptions(index), [index]);
  const existingPaths = useMemo(
    () => new Set(documents.map((d) => d.path)),
    [documents],
  );

  // The upload's own top folder (a dragged folder / zip), if it has one.
  const uploadRoot = collected !== null ? commonRoot(collected.files) : null;
  const newTrimmed = makeNew ? newName.trim() : "";
  const parentNames = useMemo(
    () => folderNamePath(index, destParent),
    [index, destParent],
  );
  const parentSegments = useMemo(
    () => (newTrimmed !== "" ? [...parentNames, newTrimmed] : parentNames),
    [parentNames, newTrimmed],
  );
  const dropWrapper = uploadRoot !== null && !keepWrapper;
  const placed = useMemo<readonly CollectedFile[]>(
    () =>
      collected === null
        ? []
        : placeEntries(collected.files, parentSegments, dropWrapper),
    [collected, parentSegments, dropWrapper],
  );

  // The folder this upload would create for itself (a new named folder,
  // or a kept upload wrapper) — used only to predict the link copy.
  const freshWrapperPath =
    newTrimmed !== ""
      ? parentSegments
      : uploadRoot !== null && keepWrapper
        ? [...parentSegments, uploadRoot]
        : null;
  const willLinkFolder =
    link.mode !== "none" &&
    freshWrapperPath !== null &&
    !folderExistsAtPath(index, freshWrapperPath);

  const docCount = placed.length;

  const { pending, error, run } = useSubmit(async () => {
    if (collected === null || placed.length === 0) return;
    if (makeNew && newTrimmed === "") {
      throw new Error("Name the new folder, or uncheck “Create a new folder”.");
    }
    if (placed.length > MAX_ENTRIES) {
      throw new Error(
        `That’s ${placed.length} files — split it into uploads of ${MAX_ENTRIES} or fewer.`,
      );
    }
    const result = await importDocumentsAndLink({
      data: {
        projectId,
        entries: placed.map((f) => ({ path: f.path, markdown: f.text })),
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
          `flex flex-col items-center gap-4 border-dashed py-12! text-center ${
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
            className="inline-flex items-center gap-1.5!"
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
          <Review
            placed={placed}
            skipped={collected.skipped}
            existingPaths={existingPaths}
          />

          <DestinationPicker
            options={options}
            destParent={destParent}
            onDestParent={setDestParent}
            makeNew={makeNew}
            onMakeNew={setMakeNew}
            newName={newName}
            onNewName={setNewName}
            uploadRoot={uploadRoot}
            keepWrapper={keepWrapper}
            onKeepWrapper={setKeepWrapper}
            destLabel={parentSegments.join(" / ")}
          />

          <LinkPicker
            collections={collections}
            value={link}
            onChange={setLink}
            willLinkFolder={willLinkFolder}
            docCount={docCount}
          />

          {error && <p className="text-base text-red-600">{error}</p>}
          <Button type="submit" disabled={pending || placed.length === 0}>
            {pending
              ? "Importing…"
              : `Import ${docCount} document${docCount === 1 ? "" : "s"}`}
          </Button>
        </form>
      )}
    </>
  );
}

// Shows the files at their RESOLVED destination paths (what the import
// will actually write), flagging any that update an existing document at
// the same path.
function Review({
  placed,
  skipped,
  existingPaths,
}: Readonly<{
  placed: readonly CollectedFile[];
  skipped: Collected["skipped"];
  existingPaths: ReadonlySet<string>;
}>) {
  const updates = placed.filter((f) => existingPaths.has(f.path)).length;
  return (
    <div>
      <p className="text-base text-slate-700">
        <span className="font-medium">{placed.length}</span> file
        {placed.length === 1 ? "" : "s"} ready
        {skipped.length > 0 && (
          <>
            {" · "}
            <span className="text-amber-700">{skipped.length} skipped</span>
          </>
        )}
      </p>
      {updates > 0 && (
        <p className="mt-1 text-sm text-amber-700">
          {updates} {updates === 1 ? "file updates" : "files update"} an
          existing document at the same path (a new version, not a duplicate).
        </p>
      )}
      {placed.length > 0 && (
        <ul
          className={listSurface(
            "mt-2 max-h-56 divide-y divide-slate-200 overflow-y-auto",
          )}
        >
          {placed.map((f) => (
            <li
              key={f.path}
              className="flex items-center justify-between gap-2 px-3 py-1.5 font-mono text-sm text-slate-700"
            >
              <span className="truncate">{f.path}</span>
              {existingPaths.has(f.path) && (
                <span className="shrink-0 font-sans text-sm text-amber-700">
                  updates existing
                </span>
              )}
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

// Where the upload lands in the folder tree: a parent (root by default
// or any existing folder), an optional new folder created under it, and
// — for a folder/zip upload — whether to keep its own top folder or
// merge its files into the destination.
function DestinationPicker({
  options,
  destParent,
  onDestParent,
  makeNew,
  onMakeNew,
  newName,
  onNewName,
  uploadRoot,
  keepWrapper,
  onKeepWrapper,
  destLabel,
}: Readonly<{
  options: readonly Readonly<{ slug: FolderSlug; label: string }>[];
  destParent: FolderSlug | null;
  onDestParent: (v: FolderSlug | null) => void;
  makeNew: boolean;
  onMakeNew: (v: boolean) => void;
  newName: string;
  onNewName: (v: string) => void;
  uploadRoot: string | null;
  keepWrapper: boolean;
  onKeepWrapper: (v: boolean) => void;
  // The resolved merge target ("" = project root) — names where a
  // wrapper-dropped folder's files actually land.
  destLabel: string;
}>): React.ReactElement {
  return (
    <div className="space-y-3">
      {/* Always shown — even with no folders yet — so a single-file
          upload always surfaces its destination and the Root default,
          gaining folder entries as soon as any exist. */}
      <div>
        <label
          htmlFor="dest"
          className="mb-1 block text-sm font-medium text-slate-700"
        >
          Import into
        </label>
        <select
          id="dest"
          value={destParent ?? ROOT}
          onChange={(e) =>
            onDestParent(
              e.target.value === ROOT ? null : asFolderSlug(e.target.value),
            )
          }
          className={fieldInputClass()}
        >
          <option value={ROOT}>Root</option>
          {options.map((o) => (
            <option key={o.slug} value={o.slug}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="flex items-center gap-2 text-base text-slate-700">
          <input
            type="checkbox"
            checked={makeNew}
            onChange={(e) => onMakeNew(e.target.checked)}
          />
          Create a new folder here
        </label>
        {makeNew && (
          <input
            autoFocus
            value={newName}
            onChange={(e) => onNewName(e.target.value)}
            placeholder="Folder name"
            className={fieldInputClass("mt-2 ml-6 w-[calc(100%-1.5rem)]!")}
          />
        )}
      </div>

      {uploadRoot !== null && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-700">
            The uploaded folder
          </legend>
          <label className="flex items-center gap-2 text-base text-slate-700">
            <input
              type="radio"
              name="wrapper"
              checked={keepWrapper}
              onChange={() => onKeepWrapper(true)}
            />
            Keep the folder “{uploadRoot}”
          </label>
          <label className="flex items-center gap-2 text-base text-slate-700">
            <input
              type="radio"
              name="wrapper"
              checked={!keepWrapper}
              onChange={() => onKeepWrapper(false)}
            />
            {destLabel === "" ? (
              "Add its files directly to the root"
            ) : (
              <>Add its files directly to “{destLabel}”</>
            )}
          </label>
        </fieldset>
      )}
    </div>
  );
}

function LinkPicker({
  collections,
  value,
  onChange,
  willLinkFolder,
  docCount,
}: Readonly<{
  collections: readonly Readonly<{ slug: CollectionSlug; name: string }>[];
  value: ImportCollectionLink;
  onChange: (v: ImportCollectionLink) => void;
  willLinkFolder: boolean;
  docCount: number;
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
          className={fieldInputClass("ml-6 w-[calc(100%-1.5rem)]!")}
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
          className={fieldInputClass("ml-6 w-[calc(100%-1.5rem)]!")}
        >
          {collections.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
        </select>
      )}
      {value.mode !== "none" && (
        <p className="text-sm text-slate-500">
          {willLinkFolder
            ? "This upload creates a new folder; linking it is live — files added to it later are in the collection automatically."
            : `The ${docCount} uploaded document${
                docCount === 1 ? "" : "s"
              } will be added to the collection.`}
        </p>
      )}
    </fieldset>
  );
}
