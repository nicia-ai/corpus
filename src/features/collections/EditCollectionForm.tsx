import { useState } from "react";

import { Field, fieldInputClass } from "@/components/Field";
import { Button } from "@/components/ui/Button";
import { cardClass } from "@/components/ui/Surface";
import type { CollectionSlug, ProjectId } from "@/ids";
import { cn } from "@/lib/cn";
import { useSubmit } from "@/lib/forms";
import { updateCollection } from "@/lib/server/collections";
import {
  alwaysIncludeBudgetTokensZ,
  DEFAULT_ALWAYS_INCLUDE_BUDGET_TOKENS,
  formatNumber,
  MAX_ALWAYS_INCLUDE_BUDGET_TOKENS,
} from "@/util";

// Quick-pick budgets sized to common context windows. First entry is
// the new-collection default so a fresh collection's preset highlights
// without drift if the default ever changes. Click sets the input to
// the formatted number; the underlying validation/save path is
// identical to typing it. All entries are kept >= 1000 so the chip
// formatter ("Nk") stays exact.
const BUDGET_PRESETS = [
  DEFAULT_ALWAYS_INCLUDE_BUDGET_TOKENS,
  32_000,
  128_000,
  200_000,
] as const;

type BudgetState =
  | Readonly<{ ok: true; value: number }>
  | Readonly<{ ok: false; error: string }>;

function parseBudget(input: string): BudgetState {
  const trimmed = input.trim();
  if (trimmed === "") {
    return {
      ok: false,
      error:
        "Required. Use 0 to assert the collection should have no always-included documents.",
    };
  }
  const cleaned = trimmed.replace(/[,_\s]/g, "");
  // Surface "must be a whole number" before delegating to Zod so the
  // user-friendly digits-only message is preserved (Zod's default
  // .int().nonnegative() messages don't mention digits + the local
  // stripping conventions).
  if (/^-\d+$/.test(cleaned)) {
    return { ok: false, error: "Must be zero or positive." };
  }
  if (!/^\d+$/.test(cleaned)) {
    return {
      ok: false,
      error:
        "Must be a whole number (digits only; commas and spaces are stripped).",
    };
  }
  // `alwaysIncludeBudgetTokensZ` is the single source of truth for the
  // numeric bounds (.int().nonnegative().max(MAX)) — calling it here
  // means any future tightening (e.g. multipleOf) lands in one place
  // and the form picks it up without copy-edit drift.
  const n = Number.parseInt(cleaned, 10);
  const parsed = alwaysIncludeBudgetTokensZ.safeParse(n);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Cannot exceed ${formatNumber(MAX_ALWAYS_INCLUDE_BUDGET_TOKENS)} tokens.`,
    };
  }
  return { ok: true, value: parsed.data };
}

// Name / description / always-include budget editor. Slug is identity
// (never re-derived from the new name); membership is untouched so this
// cuts no `CollectionVersion`. Rendered as a focused card by the route.
export function EditCollectionForm({
  slug,
  projectId,
  initialName,
  initialDescription,
  initialAlwaysIncludeBudgetTokens,
  onCancel,
  onSaved,
}: Readonly<{
  slug: CollectionSlug;
  projectId: ProjectId;
  initialName: string;
  initialDescription: string;
  initialAlwaysIncludeBudgetTokens: number;
  onCancel: () => void;
  onSaved: () => void;
}>): React.ReactElement {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [budgetText, setBudgetText] = useState(
    formatNumber(initialAlwaysIncludeBudgetTokens),
  );
  const budget = parseBudget(budgetText);
  const helpId = `budget-help-${slug}`;
  const errorId = `budget-error-${slug}`;
  const { pending, error, run } = useSubmit(async () => {
    if (!budget.ok) {
      throw new Error(budget.error);
    }
    const r = await updateCollection({
      data: {
        projectId,
        slug,
        name: name.trim(),
        description: description.trim(),
        alwaysIncludeBudgetTokens: budget.value,
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
      <h1 className="text-xl font-semibold">Edit collection</h1>
      <Field label="Name" value={name} onChange={setName} />
      <Field
        label="Description"
        as="textarea"
        rows={3}
        required={false}
        value={description}
        onChange={setDescription}
      />
      <div className="flex flex-col gap-2 text-base text-slate-700">
        <label className="flex flex-col gap-1">
          <span>Always-include budget (tokens)</span>
          <input
            type="text"
            inputMode="numeric"
            value={budgetText}
            onChange={(e) => setBudgetText(e.target.value)}
            aria-invalid={!budget.ok}
            aria-describedby={budget.ok ? helpId : `${errorId} ${helpId}`}
            className={cn(
              fieldInputClass("w-40 tabular-nums"),
              !budget.ok && "border-red-400 bg-red-50",
            )}
          />
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm text-slate-500">Quick pick:</span>
          {BUDGET_PRESETS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setBudgetText(formatNumber(n))}
              className={cn(
                "rounded-md border px-2 py-0.5 text-sm tabular-nums",
                budget.ok && budget.value === n
                  ? "border-blue-300 bg-blue-50 text-blue-700"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
              )}
            >
              {String(n / 1000)}k
            </button>
          ))}
        </div>
        {!budget.ok && (
          <p id={errorId} className="text-sm text-red-600">
            {budget.error}
          </p>
        )}
        <p id={helpId} className="max-w-prose text-sm text-slate-500">
          The size threshold the meter compares the always-included documents
          against. Authoring-side guidance only — read_collection still ships
          whatever you mark “Always include.” Raise it for collections feeding
          larger context windows; lower it to keep this collection lean.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || !budget.ok}>
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
