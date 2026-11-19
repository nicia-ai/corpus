import { useState } from "react";

import { NewIntakeDialog } from "@/components/document/NewIntakeDialog";
import { Button } from "@/components/ui/Button";
import { embassyPrompt } from "@/embassy/prompt";
import type { ProjectId } from "@/ids";

const EXAMPLE_LINK = "https://your-corpus-host/s/<link>";

type ExampleSection = Readonly<{
  heading: string;
  body: string;
  writer: string;
}>;

// The hackathon scenario from docs/share-a-page.md: two coworkers, each
// with their own link, each agent writing its own section.
const EXAMPLE_SECTIONS: readonly ExampleSection[] = [
  {
    heading: "Engineering guidelines",
    body: "Teams of up to four. A working demo by Sunday 4pm. Open-source your repo.",
    writer: "Priya’s Claude Code",
  },
  {
    heading: "Location and schedule",
    body: "Pier 9, Friday 6pm to Sunday 6pm. Doors at 5:30.",
    writer: "Sam’s Claude Code",
  },
  {
    heading: "Participants",
    body: "Priya, Sam, Dana, Lee. Updated as people RSVP.",
    writer: "Sam’s Claude Code",
  },
];

const EXAMPLE_PROMPT = embassyPrompt({ url: EXAMPLE_LINK, grant: "edit" });

// The empty-project "what can I do with this" example for single-document
// collaboration. Static markup plus one dialog; the prompt is generated from
// the same function Share uses, so the example can't drift from the product.
export function SharedPageExample(
  props: Readonly<{ projectId: ProjectId }>,
): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-labelledby="shared-page-example"
      className="mt-8 rounded-lg border border-slate-200 bg-white p-6"
    >
      {open && (
        <NewIntakeDialog
          projectId={props.projectId}
          onClose={() => setOpen(false)}
        />
      )}
      <h2
        id="shared-page-example"
        className="text-xl font-semibold text-slate-900"
      >
        Share one page with a coworker’s agent
      </h2>
      <p className="mt-1 max-w-2xl text-base text-slate-500">
        Two people run a hackathon. Each puts a link in their own Claude Code
        session, and each agent writes its own section of the same page. Every
        change is labelled with the link it came through.
      </p>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="text-sm font-medium text-slate-500">
            The page, after a day
          </h3>
          <div className="mt-2 rounded-md border border-slate-200 p-4">
            <p className="text-lg font-semibold text-slate-900">
              Spring Hackathon
            </p>
            <dl className="mt-3 space-y-4">
              {EXAMPLE_SECTIONS.map((s) => (
                <div key={s.heading}>
                  <dt className="text-base font-semibold text-slate-900">
                    {s.heading}
                  </dt>
                  <dd className="mt-1 text-base text-slate-700">{s.body}</dd>
                  <dd className="mt-1 text-sm text-slate-500">
                    Written by {s.writer}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <ol className="mt-4 list-decimal space-y-1 pl-5 text-base text-slate-700">
            <li>Create the page and a link for each person.</li>
            <li>Each pastes their prompt into their agent.</li>
            <li>Priya: “Add the engineering guidelines for participants.”</li>
            <li>
              Sam: “Add the location and details, then keep the participant list
              updated as people RSVP.”
            </li>
          </ol>
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-slate-500">
            The prompt each person pastes
          </h3>
          <pre
            tabIndex={0}
            className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-sm text-slate-700"
          >
            {EXAMPLE_PROMPT}
          </pre>
          <p className="mt-2 text-sm text-slate-500">
            Each agent replaces only its own section, so edits made at the same
            time do not overwrite each other. The prompt also tells the agent to
            save the link, so it can keep working on the page next week.
          </p>
        </div>
      </div>
      <div className="mt-6">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Start a shared page
        </Button>
      </div>
    </section>
  );
}
