import { useState } from "react";

import { Field } from "@/components/Field";
import { Button } from "@/components/ui/Button";
import { cardClass } from "@/components/ui/Surface";
import type { CorpusSlug, ProjectId } from "@/ids";
import { useSubmit } from "@/lib/forms";
import { updateCorpus } from "@/lib/server/corpora";

// Name / description editor. Slug is identity (never re-derived from the
// new name) and so is the hidden root folder: renaming a corpus changes no
// corpus-relative path and cuts no `CorpusVersion`. Rendered as a focused
// card by the route.
export function EditCorpusForm({
  slug,
  projectId,
  initialName,
  initialDescription,
  onCancel,
  onSaved,
}: Readonly<{
  slug: CorpusSlug;
  projectId: ProjectId;
  initialName: string;
  initialDescription: string;
  onCancel: () => void;
  onSaved: () => void;
}>): React.ReactElement {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const { pending, error, run } = useSubmit(async () => {
    const r = await updateCorpus({
      data: {
        projectId,
        slug,
        name: name.trim(),
        description: description.trim(),
      },
    });
    if (!r.ok) throw new Error("Save failed — please retry.");
    onSaved();
  });
  return (
    <form
      className={cardClass("mt-4 space-y-4")}
      onSubmit={(e) => {
        e.preventDefault();
        void run();
      }}
    >
      <h1 className="text-xl font-semibold">Edit corpus</h1>
      <Field label="Name" value={name} onChange={setName} />
      <Field
        label="Description"
        as="textarea"
        rows={3}
        required={false}
        value={description}
        onChange={setDescription}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || name.trim() === ""}>
          Save
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        {error && <span className="text-base text-red-600">{error}</span>}
      </div>
    </form>
  );
}
