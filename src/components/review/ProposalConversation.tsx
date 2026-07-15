import { useState } from "react";

import { Field } from "@/components/Field";
import { Button } from "@/components/ui/Button";
import { RelativeTime } from "@/components/ui/DateTime";
import type { CallerChannel, ProjectId } from "@/ids";
import { useSubmit } from "@/lib/forms";
import { addProposalMessage } from "@/lib/server/suggestions";

const MAX_MESSAGE_LENGTH = 2000;

export type ProposalConversationMessage = Readonly<{
  id: number;
  body: string;
  authorLabel: string;
  channel: CallerChannel;
  createdAt: string;
}>;

export function ProposalConversation({
  projectId,
  proposalId,
  messages,
  canReply,
  onChange,
}: Readonly<{
  projectId: ProjectId;
  proposalId: number;
  messages: readonly ProposalConversationMessage[];
  canReply: boolean;
  onChange: () => void;
}>): React.ReactElement | null {
  const [reply, setReply] = useState("");
  const remaining = MAX_MESSAGE_LENGTH - reply.length;
  const helpId = `proposal-message-help-${String(proposalId)}`;
  const {
    pending,
    error,
    run: send,
  } = useSubmit(async () => {
    const result = await addProposalMessage({
      data: { projectId, suggestionId: proposalId, body: reply },
    });
    if (!result.ok) {
      throw new Error(
        result.reason === "not-open"
          ? "This proposal is already settled."
          : "This proposal no longer exists.",
      );
    }
    setReply("");
    onChange();
  });

  if (messages.length === 0 && !canReply) return null;

  return (
    <section aria-label="Proposal conversation" className="space-y-2">
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {messages.length === 0
          ? "No proposal messages."
          : `${String(messages.length)} proposal message${messages.length === 1 ? "" : "s"}.`}
      </p>
      {messages.length > 0 && (
        <ol className="max-h-64 space-y-2 overflow-auto border-l border-slate-200 pl-3 pr-1">
          {messages.map((message) => (
            <li key={message.id} className="space-y-0.5 text-sm">
              <div className="flex flex-wrap items-center gap-1.5 text-slate-500">
                <span className="font-medium text-slate-700">
                  {message.authorLabel}
                </span>
                <span>via {message.channel.toUpperCase()}</span>
                <RelativeTime iso={message.createdAt} />
              </div>
              <p className="whitespace-pre-wrap text-slate-700 [overflow-wrap:anywhere]">
                {message.body}
              </p>
            </li>
          ))}
        </ol>
      )}
      {canReply && (
        <div className="space-y-2">
          <Field
            label="Message proposer"
            as="textarea"
            rows={2}
            maxLength={MAX_MESSAGE_LENGTH}
            required={false}
            value={reply}
            onChange={setReply}
            ariaDescribedBy={helpId}
          />
          <p id={helpId} className="text-sm text-slate-500 tabular-nums">
            {String(remaining)} characters remaining
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              disabled={pending || reply.trim() === ""}
              onClick={() => void send()}
            >
              Send message
            </Button>
            {error !== undefined && (
              <span className="text-sm text-red-600" role="alert">
                {error}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
