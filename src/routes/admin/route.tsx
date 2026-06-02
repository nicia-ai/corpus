import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { adminGuard } from "@/lib/server/admin";

// Platform-admin surface (whole-product visibility), distinct from the
// per-project app shell. The loader is the gate: adminGuard throws for
// non-admins (and the unauthenticated), which we turn into a redirect to
// the app root rather than an error page. Server fns re-check on every
// call — this guard is for UX, not security.
export const Route = createFileRoute("/admin")({
  component: AdminLayout,
  loader: async () => {
    try {
      return await adminGuard();
    } catch {
      throw redirect({ to: "/" });
    }
  },
});

const tab =
  "rounded-md px-2.5 py-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900";
const tabActive = "bg-slate-900 text-white hover:bg-slate-900 hover:text-white";

function AdminLayout(): React.ReactElement {
  const admin = Route.useLoaderData();
  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <Link
        to="/"
        className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
      >
        ← Back to app
      </Link>
      <header className="mb-8 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Admin</h1>
          <p className="text-sm text-slate-500">
            Platform-wide visibility &amp; management · {admin.email}
          </p>
        </div>
        <nav className="flex items-center gap-1 text-sm">
          <Link
            to="/admin"
            activeOptions={{ exact: true }}
            className={tab}
            activeProps={{ className: `${tab} ${tabActive}` }}
          >
            Overview
          </Link>
          <Link
            to="/admin/projects"
            className={tab}
            activeProps={{ className: `${tab} ${tabActive}` }}
          >
            Projects
          </Link>
        </nav>
      </header>
      <Outlet />
    </div>
  );
}
