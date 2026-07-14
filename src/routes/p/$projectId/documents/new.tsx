import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";

import { DocumentActionBar } from "@/components/document/DocumentActionBar";
import { RenameField } from "@/components/document/RenameField";
import { MarkdownEditor } from "@/components/markdown/MarkdownEditor";
import { BackLink } from "@/components/ui/BackLink";
import { Button } from "@/components/ui/Button";
import { textLinkClass } from "@/components/ui/text-link";
import { asProjectId } from "@/ids";
import { track } from "@/lib/analytics";
import { useSubmit } from "@/lib/forms";
import { getDocumentRefs, saveDocument } from "@/lib/server/documents";
import { defaultFilename } from "@/store/domain/paths";
import { compact, slugify } from "@/util";

export const Route = createFileRoute("/p/$projectId/documents/new")({
  component: NewDoc,
  // Slugs feed the editor's broken-link linter. The new-document page is
  // always an authoring surface (unlike a read view), so the list loads up
  // front here. The linter is purely cosmetic and "never blocks Save", so a
  // failed fetch must not error the whole authoring page — fall back to no
  // known slugs (every link then just lints as unknown until the page reloads).
  loader: async ({ params }) => {
    try {
      return await getDocumentRefs({
        data: { projectId: params.projectId },
      });
    } catch {
      return [];
    }
  },
});

function NewDoc() {
  const nav = useNavigate();
  const projectId = asProjectId(Route.useParams().projectId);
  const docRefs = Route.useLoaderData();
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [broken, setBroken] = useState(0);
  // undefined = still tracking the title-derived default; set once the
  // user explicitly renames it via the "Rename file" toggle below.
  const [filename, setFilename] = useState<string>();
  const [renamingFile, setRenamingFile] = useState(false);
  const errorId = useId();
  const slug = slugify(title);
  const effectiveFilename = filename ?? defaultFilename(slug);
  const { pending, error, run } = useSubmit(async () => {
    if (title.trim() === "") {
      throw new Error("Title cannot be empty.");
    }
    // The editor is a contenteditable div, not a `required` form control, so
    // guard the empty body here (the old textarea's native `required` did this).
    if (markdown.trim() === "") {
      throw new Error("Document body cannot be empty.");
    }
    const r = await saveDocument({
      data: compact({
        projectId,
        slug,
        title,
        markdown,
        filename,
        clientVersion: 0,
      }),
    });
    if (!r.ok) {
      throw new Error(
        "conflict" in r
          ? "A document with this title already exists."
          : "segmentCollision" in r
            ? "A file with this name already exists."
            : "Save failed — please retry.",
      );
    }
    track("document_created", { projectId, slug });
    await nav({
      to: "/p/$projectId/documents/$slug",
      params: { projectId, slug },
    });
  });
  const describedBy = error !== undefined ? errorId : undefined;

  // Unified with the edit surface (DocumentEditor): white document ground
  // (route.tsx), max-w-doc measure, borderless full-page editor, and the
  // same sticky-bottom action bar — creating a document should feel like
  // the same product as editing one, not a detached settings-style form.
  return (
    <div className="mx-auto max-w-doc">
      <BackLink
        to="/p/$projectId/documents"
        projectId={projectId}
        label="Documents"
        className="mb-4 inline-block"
      />
      <div>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled document"
          aria-label="Document title"
          aria-describedby={describedBy}
          autoFocus
          className="mb-2 w-full border-0 border-b border-transparent bg-transparent px-0 py-1 text-2xl font-semibold text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
        />
        {renamingFile ? (
          <RenameField
            label="File name"
            initial={effectiveFilename}
            pending={false}
            mono
            onSave={(f) => {
              const trimmed = f.trim();
              if (trimmed !== "") setFilename(trimmed);
              setRenamingFile(false);
            }}
            onCancel={() => setRenamingFile(false)}
          />
        ) : (
          <div className="mb-5 flex items-center gap-2 text-sm text-slate-500">
            <span className="font-mono">{effectiveFilename}</span>
            <button
              type="button"
              onClick={() => setRenamingFile(true)}
              className={textLinkClass("text-sm")}
            >
              Rename file
            </button>
          </div>
        )}
        <MarkdownEditor
          value={markdown}
          onChange={setMarkdown}
          docRefs={docRefs}
          selfSlug={slug}
          onBrokenChange={setBroken}
          ariaLabel="Document body"
          ariaDescribedBy={describedBy}
          onSave={() => void run()}
        />
        <DocumentActionBar
          broken={broken}
          error={
            error && (
              <p id={errorId} role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )
          }
        >
          <Button type="button" disabled={pending} onClick={() => void run()}>
            Create
          </Button>
        </DocumentActionBar>
      </div>
    </div>
  );
}
