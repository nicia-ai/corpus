import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Field } from "@/components/Field";
import { Button } from "@/components/ui/Button";
import { cardClass } from "@/components/ui/Surface";
import type { ProjectId } from "@/ids";
import { track } from "@/lib/analytics";
import { useSubmit } from "@/lib/forms";
import { createCorpus } from "@/lib/server/corpora";

// Name a new corpus and land inside it — its tree is where the next step
// (adding pages) happens.
export function CreateCorpusForm({
  projectId,
  onCancel,
}: Readonly<{
  projectId: ProjectId;
  onCancel: () => void;
}>): React.ReactElement {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const {
    pending,
    error,
    run: submit,
  } = useSubmit(async () => {
    const desc = description.trim();
    const r = await createCorpus({
      data:
        desc === ""
          ? { projectId, name: name.trim() }
          : { projectId, name: name.trim(), description: desc },
    });
    track("corpus_created", { projectId, slug: r.slug });
    await navigate({
      to: "/p/$projectId/corpora/$slug",
      params: { projectId, slug: r.slug },
    });
  });

  return (
    <form
      className={cardClass("mb-6 max-w-xl space-y-4")}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="Name" value={name} onChange={setName} />
      <Field
        label="Description"
        required={false}
        value={description}
        onChange={setDescription}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || name.trim() === ""}>
          {pending ? "Creating…" : "Create corpus"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </form>
  );
}
