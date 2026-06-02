import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Field } from "@/components/Field";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { cardClass } from "@/components/ui/Surface";
import { asProjectId } from "@/ids";
import { track } from "@/lib/analytics";
import { useSubmit } from "@/lib/forms";
import { saveDocument } from "@/lib/server/documents";
import { slugify } from "@/util";

export const Route = createFileRoute("/p/$projectId/documents/new")({
  component: NewDoc,
});

function NewDoc() {
  const nav = useNavigate();
  const projectId = asProjectId(Route.useParams().projectId);
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const { pending, error, run } = useSubmit(async () => {
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
        <Field label="Title" value={title} onChange={setTitle} />
        <Field
          label="Markdown"
          as="textarea"
          rows={14}
          mono
          value={markdown}
          onChange={setMarkdown}
        />
        {error && <p className="text-base text-red-600">{error}</p>}
        <Button type="submit" disabled={pending}>
          Create
        </Button>
      </form>
    </div>
  );
}
