import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";

import { Field, FieldLabel } from "@/components/Field";
import { MarkdownEditor } from "@/components/markdown/MarkdownEditor";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { cardClass } from "@/components/ui/Surface";
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
  const errorId = useId();
  const { pending, error, run } = useSubmit(async () => {
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
  return (
    <div className="max-w-2xl">
      <PageHeader title="New document" />
      <form
        className={cardClass("space-y-4")}
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Field
          label="Title"
          value={title}
          onChange={setTitle}
          ariaDescribedBy={describedBy}
        />
        <div className="block">
          <FieldLabel>Markdown</FieldLabel>
          <MarkdownEditor
            value={markdown}
            onChange={setMarkdown}
            docSlugs={slugs}
            selfSlug={slugify(title)}
            ariaLabel="Markdown"
            ariaDescribedBy={describedBy}
          />
        </div>
        {error && (
          <p id={errorId} role="alert" className="text-base text-red-600">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending}>
          Create
        </Button>
      </form>
    </div>
  );
}
