import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";

import { DocumentActionBar } from "@/components/document/DocumentActionBar";
import { MarkdownEditor } from "@/components/markdown/MarkdownEditor";
import { BackLink } from "@/components/ui/BackLink";
import { Button } from "@/components/ui/Button";
import { asProjectId } from "@/ids";
import { track } from "@/lib/analytics";
import { useSubmit } from "@/lib/forms";
import { getDocuments, saveDocument } from "@/lib/server/documents";
import { slugify } from "@/util";

export const Route = createFileRoute("/p/$projectId/documents/new")({
  component: NewDoc,
  // Slugs feed the editor's broken-link linter. The new-document page is
  // always an authoring surface (unlike a read view), so the list loads up
  // front here. The linter is purely cosmetic and "never blocks Save", so a
  // failed fetch must not error the whole authoring page — fall back to no
  // known slugs (every link then just lints as unknown until the page reloads).
  loader: async ({ params }) => {
    try {
      const docs = await getDocuments({
        data: { projectId: params.projectId },
      });
      return docs.map((d) => d.slug);
    } catch {
      return [];
    }
  },
});

function NewDoc() {
  const nav = useNavigate();
  const projectId = asProjectId(Route.useParams().projectId);
  const slugs = Route.useLoaderData();
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [broken, setBroken] = useState(0);
  const errorId = useId();
  const { pending, error, run } = useSubmit(async () => {
    if (title.trim() === "") {
      throw new Error("Title cannot be empty.");
    }
    // The editor is a contenteditable div, not a `required` form control, so
    // guard the empty body here (the old textarea's native `required` did this).
    if (markdown.trim() === "") {
      throw new Error("Document body cannot be empty.");
    }
    const slug = slugify(title);
    const r = await saveDocument({
      data: { projectId, slug, title, markdown, clientVersion: 0 },
    });
    if (!r.ok) {
      throw new Error(
        "conflict" in r
          ? "A document with this title already exists."
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
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled document"
          aria-label="Document title"
          aria-describedby={describedBy}
          autoFocus
          className="mb-5 w-full border-0 border-b border-transparent bg-transparent px-0 py-1 text-2xl font-semibold text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
        />
        <MarkdownEditor
          value={markdown}
          onChange={setMarkdown}
          docSlugs={slugs}
          selfSlug={slugify(title)}
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
          <Button type="submit" disabled={pending}>
            Create
          </Button>
        </DocumentActionBar>
      </form>
    </div>
  );
}
