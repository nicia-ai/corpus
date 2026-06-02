import type { ErrorComponentProps } from "@tanstack/react-router";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Surface";

export function RoutePending(): React.ReactElement {
  return (
    <Card className="mx-auto max-w-xl">
      <p className="text-base text-slate-500">Loading…</p>
    </Card>
  );
}

export function RouteError({
  error,
  reset,
}: ErrorComponentProps): React.ReactElement {
  const message =
    error instanceof Error ? error.message : "This page could not load.";
  return (
    <Card className="mx-auto max-w-xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">
          Something went wrong
        </h1>
        <p className="mt-1 text-base text-slate-500">{message}</p>
      </div>
      <Button variant="secondary" onClick={reset}>
        Try again
      </Button>
    </Card>
  );
}
