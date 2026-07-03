import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { RelativeTime } from "@/components/ui/DateTime";
import { cardClass, EmptyState, listSurface } from "@/components/ui/Surface";
import { showToast } from "@/components/ui/Toast";
import { authClient } from "@/lib/auth-client";
import {
  adminListUsers,
  adminOverview,
  type AdminUserRow,
} from "@/lib/server/admin";

export const Route = createFileRoute("/admin/")({
  component: AdminOverviewPage,
  loader: async () => {
    const [overview, users] = await Promise.all([
      adminOverview(),
      adminListUsers(),
    ]);
    return { overview, users };
  },
});

function Stat({
  label,
  value,
}: Readonly<{ label: string; value: number }>): React.ReactElement {
  return (
    <div className={cardClass("!p-4")}>
      <div className="text-3xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-sm font-medium text-slate-500">{label}</div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "Action failed.";
}

function AdminOverviewPage(): React.ReactElement {
  const { overview, users } = Route.useLoaderData();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  // Run a mutating admin action, surface its result, then reload the
  // loader so the table reflects the new state. `key` (the user id) drives
  // the per-row busy state.
  async function run(
    key: string,
    fn: () => Promise<{ error?: unknown }>,
    ok: string,
  ): Promise<void> {
    setBusy(key);
    try {
      const res = await fn();
      if (res.error) {
        showToast(errorMessage(res.error));
        return;
      }
      showToast(ok);
      await router.invalidate();
    } finally {
      setBusy(null);
    }
  }

  async function ban(u: AdminUserRow): Promise<void> {
    if (u.banned) {
      await run(
        u.id,
        () => authClient.admin.unbanUser({ userId: u.id }),
        "User unbanned.",
      );
      return;
    }
    const ok = await confirmDialog({
      title: `Ban ${u.email}?`,
      body: "They are signed out immediately and blocked from signing in.",
      confirmLabel: "Ban user",
      tone: "danger",
    });
    if (ok) {
      await run(
        u.id,
        () =>
          authClient.admin.banUser({
            userId: u.id,
            banReason: "Banned by admin",
          }),
        "User banned.",
      );
    }
  }

  async function impersonate(u: AdminUserRow): Promise<void> {
    const res = await authClient.admin.impersonateUser({ userId: u.id });
    if (res.error) {
      showToast(errorMessage(res.error));
      return;
    }
    // The session cookie is now the impersonated user's — full reload so
    // the whole app picks it up.
    window.location.href = "/";
  }

  async function remove(u: AdminUserRow): Promise<void> {
    const ok = await confirmDialog({
      title: `Delete ${u.email}?`,
      body: "Permanently removes this user. Organizations they belong to are unaffected.",
      confirmLabel: "Delete user",
      tone: "danger",
    });
    if (ok) {
      await run(
        u.id,
        () => authClient.admin.removeUser({ userId: u.id }),
        "User deleted.",
      );
    }
  }

  const methods = Object.entries(overview.signupsByMethod);
  const action =
    "text-left text-sm text-blue-600 hover:underline disabled:opacity-40";
  // Fixed columns so each action lines up vertically across rows despite
  // the label-width swing (Make admin / Revoke admin, Ban / Unban).
  const actionGrid =
    "grid grid-cols-[6.5rem_3.5rem_6rem_auto] items-center justify-items-start gap-x-2";

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Signups" value={overview.users} />
        <Stat label="Organizations" value={overview.organizations} />
        <Stat label="Projects" value={overview.projects} />
        <Stat label="Platform admins" value={overview.admins} />
      </section>

      {methods.length > 0 && (
        <p className="text-sm text-slate-500">
          Signups by method:{" "}
          {methods
            .map(([m, n]) => `${m === "credential" ? "email" : m} (${n})`)
            .join(" · ")}
        </p>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">
          Users ({users.length})
        </h2>
        {users.length === 0 ? (
          <EmptyState>No users yet.</EmptyState>
        ) : (
          <div className={listSurface()}>
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-sm text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">User</th>
                  <th className="px-4 py-2 font-medium">Platform role</th>
                  <th className="px-4 py-2 font-medium">Orgs</th>
                  <th className="px-4 py-2 font-medium">Joined</th>
                  <th className="px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.map((u) => (
                  <tr
                    key={u.id}
                    className={u.banned ? "bg-red-50/40" : undefined}
                  >
                    <td className="px-4 py-2">
                      <div className="font-medium text-slate-900">
                        {u.name || "—"}
                      </div>
                      <div className="text-sm text-slate-500">
                        {u.email}
                        {u.emailVerified ? "" : " · unverified"}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      {u.role === "admin" ? (
                        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-sm font-medium text-blue-700">
                          admin
                        </span>
                      ) : (
                        <span className="text-sm text-slate-500">user</span>
                      )}
                      {u.banned && (
                        <span className="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-sm font-medium text-red-700">
                          banned
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-slate-600">
                      {u.organizations}
                    </td>
                    <td className="px-4 py-2 text-slate-600">
                      <RelativeTime iso={new Date(u.createdAt).toISOString()} />
                    </td>
                    <td className="px-4 py-2">
                      <div className={actionGrid}>
                        <button
                          className={action}
                          disabled={busy === u.id}
                          onClick={() =>
                            void run(
                              u.id,
                              () =>
                                authClient.admin.setRole({
                                  userId: u.id,
                                  role: u.role === "admin" ? "user" : "admin",
                                }),
                              u.role === "admin"
                                ? "Admin revoked."
                                : "Promoted to admin.",
                            )
                          }
                        >
                          {u.role === "admin" ? "Revoke admin" : "Make admin"}
                        </button>
                        <button
                          className={action}
                          disabled={busy === u.id}
                          onClick={() => void ban(u)}
                        >
                          {u.banned ? "Unban" : "Ban"}
                        </button>
                        <button
                          className={action}
                          disabled={busy === u.id}
                          onClick={() => void impersonate(u)}
                        >
                          Impersonate
                        </button>
                        <button
                          className="text-left text-sm text-red-600 hover:underline disabled:opacity-40"
                          disabled={busy === u.id}
                          onClick={() => void remove(u)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
