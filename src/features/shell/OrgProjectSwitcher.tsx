import { Link, useNavigate } from "@tanstack/react-router";
import { Check, ChevronsUpDown, Plus, Settings } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { fieldInputClass } from "@/components/Field";
import { buttonStyles } from "@/components/ui/Button";
import type { ProjectId } from "@/ids";
import { track } from "@/lib/analytics";
import { useSubmit } from "@/lib/forms";
import { createProject } from "@/lib/server/projects";
import { createOrganization, type ProjectShell } from "@/lib/server/session";

// Combined org ▸ project identity + switcher. Always shown (it is the
// only way a single-project user reaches "+ New project" / "+ New
// organization" — the feature that lets them grow past the default).
// Switching is plain navigation to `/p/<projectId>`, never a
// session-state mutation: the URL is the source of truth, so a switched
// tab and a shared link agree. The menu groups *display* by org; you
// still navigate by the globally-unique project id.
export function OrgProjectSwitcher({
  shell,
  projectId,
}: Readonly<{
  shell: ProjectShell;
  projectId: ProjectId;
}>): React.ReactElement {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState<"project" | "org" | undefined>();
  const [name, setName] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const { current, orgs } = shell;
  const isOwner = current.role === "owner";

  // The single close path (collapses the menu and discards any
  // half-typed inline-form name) — every dismissal goes through it so
  // they can't drift. Stable via setter identity, so the effect lists
  // only it.
  const closeMenu = useCallback(() => {
    setOpen(false);
    setCreating(undefined);
    setName("");
  }, []);

  // Outside-click / Escape close. No menu primitive exists in the
  // bundle by design.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, closeMenu]);

  const goTo = async (id: ProjectId): Promise<void> => {
    closeMenu();
    await navigate({ to: "/p/$projectId", params: { projectId: id } });
  };

  const newProject = useSubmit(async () => {
    const r = await createProject({ data: { projectId, name } });
    track("project_created", { projectId: r.projectId });
    await goTo(r.projectId);
  });
  const newOrg = useSubmit(async () => {
    const r = await createOrganization({
      data: { name, allowAdditional: true },
    });
    track("organization_created", { projectId: r.projectId });
    await goTo(r.projectId);
  });

  const inlineForm = (
    submit: ReturnType<typeof useSubmit>,
    placeholder: string,
  ) => (
    <form
      className="px-2 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit.run();
      }}
    >
      <input
        autoFocus
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={placeholder}
        className={fieldInputClass("text-sm")}
      />
      {submit.error && (
        <p className="mt-1 text-sm text-red-600">{submit.error}</p>
      )}
      <button
        type="submit"
        disabled={submit.pending}
        className={buttonStyles("primary", "mt-2 w-full px-3 py-1.5 text-sm")}
      >
        Create
      </button>
    </form>
  );

  const menuAction = (
    key: "project" | "org",
    icon: ReactNode,
    label: string,
  ) =>
    creating === key ? (
      inlineForm(
        key === "project" ? newProject : newOrg,
        key === "project" ? "Project name" : "Organization name",
      )
    ) : (
      <button
        type="button"
        onClick={() => {
          setCreating(key);
          setName("");
        }}
        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900"
      >
        {icon}
        {label}
      </button>
    );

  return (
    <div ref={boxRef} className="relative mb-5">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-left hover:bg-slate-50"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-slate-500">
            {current.orgName}
          </div>
          <div className="truncate text-base font-medium text-slate-900">
            {current.project.name}
          </div>
        </div>
        <ChevronsUpDown className="size-4 shrink-0 text-slate-400" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[70vh] overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-sm"
        >
          {orgs.map((org) => (
            <div key={org.id} className="py-1">
              <div className="px-2 pb-1 text-sm text-slate-500">{org.name}</div>
              {org.projects.map((p) => (
                <Link
                  key={p.id}
                  to="/p/$projectId"
                  params={{ projectId: p.id }}
                  onClick={closeMenu}
                  className="flex items-center gap-2 rounded-md px-2 py-2 text-base text-slate-700 hover:bg-slate-50 hover:text-slate-900"
                >
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.id === current.project.id && (
                    <Check className="size-4 shrink-0 text-blue-600" />
                  )}
                </Link>
              ))}
              {org.id === current.orgId &&
                isOwner &&
                menuAction(
                  "project",
                  <Plus className="size-4 shrink-0" />,
                  "New project",
                )}
            </div>
          ))}
          <div className="my-1 border-t border-slate-200" />
          {menuAction(
            "org",
            <Plus className="size-4 shrink-0" />,
            "New organization",
          )}
          {isOwner && (
            <Link
              to="/p/$projectId/settings"
              params={{ projectId }}
              onClick={closeMenu}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900"
            >
              <Settings className="size-4 shrink-0" />
              Manage project
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
