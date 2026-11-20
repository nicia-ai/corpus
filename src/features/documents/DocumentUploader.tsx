import { useRouter } from "@tanstack/react-router";
import { FolderUp, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { fieldInputClass } from "@/components/Field";
import { Button } from "@/components/ui/Button";
import { cardClass, listSurface } from "@/components/ui/Surface";
import {
  asCorpusSlug,
  asFolderSlug,
  type CorpusSlug,
  type FolderSlug,
  type ProjectId,
} from "@/ids";
import { useSubmit } from "@/lib/forms";
import type { CorpusListItem } from "@/lib/server/corpora";
import {
  type FolderRow,
  type ImportIntoCorpusResult,
  importIntoCorpus,
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
import type { ImportDestination } from "@/project-store/contracts";
import { DEFAULT_CORPUS_SLUG } from "@/store/domain/default-corpus";

// The whole upload flow as one component, shared between the dedicated
// /import route (page mode, with a Done summary) and the empty-state
// (inline mode, where the route loader's re-render IS the success state —
// no Done needed). The caller owns the surrounding PageHeader so each
// surface frames the action with its own words.
//
// An upload lands in exactly one corpus; every path is relative to that
// corpus's root. The drafts space is a corpus like any other here — it is
// the default, and the copy says plainly that agents cannot read it.

const MAX_ENTRIES = 5000;
const ROOT = "" as const;
const NEW_CORPUS = "+new-corpus" as const;

type FolderIndex = ReadonlyMap<FolderSlug, FolderRow>;
type UploadDocument = Readonly<{ path: string; corpusSlug: CorpusSlug }>;

function indexFolders(folders: readonly FolderRow[]): FolderIndex {
  return new Map(folders.map((f) => [f.slug, f]));
}

// Ancestor folder NAMES (root → leaf) for a folder slug; `[]` for the
// corpus root. The names are what the importer resolves folders by.
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

function folderOptions(
  index: FolderIndex,
  corpusSlug: CorpusSlug,
): readonly Readonly<{ slug: FolderSlug; label: string }>[] {
  return [...index.values()]
    .filter((f) => f.corpusSlug === corpusSlug)
    .map((f) => ({
      slug: f.slug,
      label: folderNamePath(index, f.slug).join(" / "),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function destinationOf(
  corpusChoice: string,
  newCorpusName: string,
): ImportDestination {
  if (corpusChoice === NEW_CORPUS) {
    return { mode: "new", name: newCorpusName.trim() };
  }
  const slug = asCorpusSlug(corpusChoice);
  return slug === DEFAULT_CORPUS_SLUG
    ? { mode: "default" }
    : { mode: "existing", slug };
}

export function DocumentUploader(
  props: Readonly<{
    projectId: ProjectId;
    corpora: readonly Pick<CorpusListItem, "slug" | "name" | "served">[];
    folders: readonly FolderRow[];
    documents: readonly UploadDocument[];
    // The corpus the upload starts aimed at (the corpus page you came
    // from); the drafts space when absent.
    initialCorpusSlug?: CorpusSlug;
    // page mode hands the result back so the route can render a Done
    // summary; inline mode is fire-and-forget — router.invalidate()
    // unmounts the empty state when the new documents land.
    onComplete?: (r: ImportIntoCorpusResult) => void;
  }>,
): React.ReactElement {
  const { projectId, corpora, folders, documents, onComplete } = props;
  const router = useRouter();
  const [collected, setCollected] = useState<Collected | null>(null);
  const [dropError, setDropError] = useState<string>();
  const [corpusChoice, setCorpusChoice] = useState<string>(
    props.initialCorpusSlug ?? DEFAULT_CORPUS_SLUG,
  );
  const [newCorpusName, setNewCorpusName] = useState("");
  const [destParent, setDestParent] = useState<FolderSlug | null>(null);
  const [makeNew, setMakeNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [keepWrapper, setKeepWrapper] = useState(true);
  const [dragging, setDragging] = useState(false);
  const filesRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);

  // A fresh drop is a fresh upload: clear the folder choices so the
  // previous upload's selections never silently carry over. The corpus
  // choice is kept — it is where the person is working.
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
    setCollected(c);
  }

  const creatingCorpus = corpusChoice === NEW_CORPUS;
  const index = useMemo(() => indexFolders(folders), [folders]);
  const options = useMemo(
    () =>
      creatingCorpus ? [] : folderOptions(index, asCorpusSlug(corpusChoice)),
    [index, corpusChoice, creatingCorpus],
  );
  const existingPaths = useMemo(
    () =>
      new Set(
        documents
          .filter((d) => d.corpusSlug === corpusChoice)
          .map((d) => d.path),
      ),
    [documents, corpusChoice],
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

  const docCount = placed.length;
  const corpusName =
    corpora.find((c) => c.slug === corpusChoice)?.name ?? newCorpusName.trim();

  const { pending, error, run } = useSubmit(async () => {
    if (collected === null || placed.length === 0) return;
    if (creatingCorpus && newCorpusName.trim() === "") {
      throw new Error("Name the new corpus, or pick an existing one.");
    }
    if (makeNew && newTrimmed === "") {
      throw new Error("Name the new folder, or uncheck “Create a new folder”.");
    }
    if (placed.length > MAX_ENTRIES) {
      throw new Error(
        `That’s ${placed.length} files — split it into uploads of ${MAX_ENTRIES} or fewer.`,
      );
    }
    const result = await importIntoCorpus({
      data: {
        projectId,
        entries: placed.map((f) => ({ path: f.path, markdown: f.text })),
        destination: destinationOf(corpusChoice, newCorpusName),
      },
    });
    if (result === undefined) {
      throw new Error("That corpus no longer exists — pick another.");
    }
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
            dragging ? "border-blue-600! bg-blue-50!" : "border-slate-300!"
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

          <CorpusPicker
            corpora={corpora}
            value={corpusChoice}
            onChange={(next) => {
              setCorpusChoice(next);
              setDestParent(null);
            }}
            newName={newCorpusName}
            onNewName={setNewCorpusName}
            corpusName={corpusName}
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

// Where the upload lands in the chosen corpus's tree: a parent (top level by default
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
  // The resolved merge target ("" = corpus root) — names where a
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
          Folder
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
          <option value={ROOT}>Top level of the corpus</option>
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
              "Add its files directly to the top level"
            ) : (
              <>Add its files directly to “{destLabel}”</>
            )}
          </label>
        </fieldset>
      )}
    </div>
  );
}

// The corpus an upload lands in. Drafts is listed like any corpus; its
// line says plainly that agents cannot read it.
function CorpusPicker({
  corpora,
  value,
  onChange,
  newName,
  onNewName,
  corpusName,
}: Readonly<{
  corpora: readonly Pick<CorpusListItem, "slug" | "name" | "served">[];
  value: string;
  onChange: (v: string) => void;
  newName: string;
  onNewName: (v: string) => void;
  corpusName: string;
}>): React.ReactElement {
  const served = corpora.find((c) => c.slug === value)?.served ?? true;
  return (
    <div className="space-y-2">
      <label
        htmlFor="corpus"
        className="block text-sm font-medium text-slate-700"
      >
        Corpus
      </label>
      <select
        id="corpus"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={fieldInputClass()}
      >
        {corpora.map((c) => (
          <option key={c.slug} value={c.slug}>
            {c.served ? c.name : `${c.name} (not shared with agents)`}
          </option>
        ))}
        <option value={NEW_CORPUS}>New corpus…</option>
      </select>
      {value === NEW_CORPUS && (
        <input
          autoFocus
          value={newName}
          onChange={(e) => onNewName(e.target.value)}
          placeholder="Corpus name"
          className={fieldInputClass()}
        />
      )}
      <p className="text-sm text-slate-500">
        {served
          ? `The files join ${corpusName === "" ? "the new corpus" : `“${corpusName}”`} at the paths shown. Agents connected to it can read them.`
          : "Drafts are not shared with agents. Move pages into a corpus to publish them."}
      </p>
    </div>
  );
}
