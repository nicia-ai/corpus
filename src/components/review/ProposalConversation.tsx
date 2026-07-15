import { useState } from "react";

import { Field } from "@/components/Field";
import { Button } from "@/components/ui/Button";
import { RelativeTime } from "@/components/ui/DateTime";
import type { CallerChannel, ProjectId } from "@/ids";
import { useSubmit } from "@/lib/forms";
import { addProposalMessage } from "@/lib/server/suggestions";

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
      {messages.length > 0 && (
        <ol className="space-y-2 border-l border-slate-200 pl-3">
          {messages.map((message) => (
            <li key={message.id} className="space-y-0.5 text-sm">
              <div className="flex flex-wrap items-center gap-1.5 text-slate-500">
                <span className="font-medium text-slate-700">
                  {message.authorLabel}
                </span>
                <span>via {message.channel.toUpperCase()}</span>
                <RelativeTime iso={message.createdAt} />
              </div>
              <p className="whitespace-pre-wrap text-slate-700">
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
            required={false}
            value={reply}
            onChange={setReply}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              disabled={pending || reply.trim() === ""}
              onClick={() => void send()}
            >
              Send message
            </Button>
            {error !== undefined && (
              <span className="text-sm text-red-600">{error}</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
