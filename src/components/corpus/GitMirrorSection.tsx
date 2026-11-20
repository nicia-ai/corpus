import { useRouter } from "@tanstack/react-router";
import { CheckCircle2, CircleAlert, Clock } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import { AbsoluteTime } from "@/components/ui/DateTime";
import { Card } from "@/components/ui/Surface";
import type { ProjectId } from "@/ids";
import { useSubmit } from "@/lib/forms";
import {
  type GitMirrorStatus,
  rebuildGitMirror,
} from "@/lib/server/git-mirror";
import type { EnabledMirrorStatus } from "@/store/domain/git-mirror";

const CLONE_COMMAND = "corpus git clone";
const CLONE_WITH_HELPER_COMMAND = "corpus git clone --helper";
const SHORT_COMMIT_LENGTH = 7;

const REBUILD_REASON: Readonly<Record<"not-enabled" | "not-found", string>> = {
  "not-enabled": "The Git mirror is not enabled on this server.",
  "not-found": "That corpus no longer exists.",
};

// "Clone with Git": the read-only Git mirror of one corpus. Shows the
// command that hands out a clone (through the CLI, which exchanges the API
// key for a short-lived read token), how current the mirror is, and — for
// owners — the one action that purges its history. Renders nothing when the
// server has no mirror: the section is not a feature the page promises.
export function GitMirrorSection({
  projectId,
  corpusSlug,
  isOwner,
  status,
}: Readonly<{
  projectId: ProjectId;
  corpusSlug: string;
  isOwner: boolean;
  status: GitMirrorStatus;
}>): React.ReactElement | null {
  const router = useRouter();
  const rebuild = useSubmit(async () => {
    const confirmed = await confirmDialog({
      title: "Rebuild the Git mirror?",
      body: "The repository is deleted and recreated from the corpus as it is now. Its commit history is lost, and clones made before will not fast-forward: re-clone them.",
      confirmLabel: "Rebuild mirror",
      tone: "danger",
    });
    if (!confirmed) return;
    const result = await rebuildGitMirror({ data: { projectId, corpusSlug } });
    if (!result.ok) throw new Error(REBUILD_REASON[result.reason]);
    await router.invalidate();
  });

  if (!status.enabled) return null;

  return (
    <Card className="mt-4 space-y-5 p-4!">
      <div className="space-y-2">
        <p className="text-sm text-slate-500">
          A read-only Git clone of this corpus, for agents and sandboxes that
          work with files. Every change here becomes a commit; the tree is
          exactly what <code className="font-mono">corpus pull --all</code>{" "}
          writes.
        </p>
        <CommandLine
          command={CLONE_COMMAND}
          note="Prints a ready-to-run git clone. Its token is valid for an hour."
        />
        <CommandLine
          command={CLONE_WITH_HELPER_COMMAND}
          note="Keeps the token out of the command and keeps git pull working as it expires."
        />
      </div>

      <MirrorStatus status={status} />

      {isOwner ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              disabled={rebuild.pending}
              onClick={() => void rebuild.run()}
            >
              Rebuild mirror
            </Button>
            <Button
              variant="secondary"
              onClick={() => void router.invalidate()}
            >
              Refresh status
            </Button>
          </div>
          {rebuild.error !== undefined && (
            <p role="alert" className="text-sm text-red-700">
              {rebuild.error}
            </p>
          )}
        </div>
      ) : (
        <Button variant="secondary" onClick={() => void router.invalidate()}>
          Refresh status
        </Button>
      )}
    </Card>
  );
}

function CommandLine({
  command,
  note,
}: Readonly<{ command: string; note: string }>): React.ReactElement {
  return (
    <div>
      <div className="relative">
        <CopyButton
          value={command}
          label={`Copy ${command}`}
          className="absolute top-2 right-2"
        />
        <pre className="overflow-x-auto rounded-md border border-slate-200 bg-slate-50 p-4 pr-16 font-mono text-sm text-slate-900">
          {command}
        </pre>
      </div>
      <p className="mt-1 text-sm text-slate-500">{note}</p>
    </div>
  );
}

// State is always a word and an icon, never a colour alone.
function MirrorStatus({
  status,
}: Readonly<{ status: EnabledMirrorStatus }>): React.ReactElement {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
      <dt className="font-medium text-slate-700">Status</dt>
      <dd>
        {status.state === "synced" && (
          <span className="inline-flex items-center gap-1.5 text-green-700">
            <CheckCircle2 className="size-4" aria-hidden="true" />
            Up to date
          </span>
        )}
        {status.state === "pending" && (
          <span className="inline-flex items-center gap-1.5 text-slate-700">
            <Clock className="size-4" aria-hidden="true" />
            Pending — changes are being pushed
          </span>
        )}
        {status.state === "error" && (
          <span className="inline-flex items-start gap-1.5 text-red-700">
            <CircleAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <span>
              Error. {status.error ?? "The last push failed."} The mirror
              retries on its own.
            </span>
          </span>
        )}
      </dd>
      <dt className="font-medium text-slate-700">Last synced</dt>
      <dd className="text-slate-500 tabular-nums">
        {status.lastSyncedAt === undefined ? (
          "Not yet"
        ) : (
          <>
            <AbsoluteTime iso={status.lastSyncedAt} />
            {status.lastCommit !== undefined && (
              <>
                {" · commit "}
                <code className="font-mono">
                  {status.lastCommit.slice(0, SHORT_COMMIT_LENGTH)}
                </code>
              </>
            )}
          </>
        )}
      </dd>
    </dl>
  );
}
