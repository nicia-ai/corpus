import { Button } from "@/components/ui/Button";
import { authClient } from "@/lib/auth-client";
import { useSubmit } from "@/lib/forms";

// "Continue with Google" for the sign-in / sign-up pages, rendered only
// when the server reports Google is configured (getGoogleEnabled). The
// secondary variant is deliberate: DESIGN.md reserves the blue accent for
// the primary email action. `signIn.social` is built into the react
// client — on success it redirects the browser to Google, so there is no
// in-app navigation to race; only a pre-redirect failure surfaces here.
export function GoogleSignInButton({
  callbackURL,
}: Readonly<{ callbackURL: string }>): React.ReactElement {
  const { pending, error, run } = useSubmit(async () => {
    const r = await authClient.signIn.social({
      provider: "google",
      callbackURL,
    });
    if (r.error) throw new Error(r.error.message ?? "Google sign-in failed");
  });
  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-center gap-3 text-base text-slate-500">
        <span className="h-px flex-1 bg-slate-200" />
        or
        <span className="h-px flex-1 bg-slate-200" />
      </div>
      {error && <p className="text-base text-red-600">{error}</p>}
      <Button
        variant="secondary"
        disabled={pending}
        className="w-full"
        onClick={() => void run()}
      >
        Continue with Google
      </Button>
    </div>
  );
}
