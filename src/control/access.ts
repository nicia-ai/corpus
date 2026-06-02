import { and, eq, sql } from "drizzle-orm";

import type { ProjectId } from "../ids";

import type { ControlDb } from "./db";
import { type Project, project } from "./schema/app";

export type Role = "owner" | "member";

// Better Auth's `member.role` is an open, comma-joinable string (its
// default roles are owner | admin | member, and a member can hold
// several). Nicia models only owner vs member: any role set containing
// "owner" is an owner.
export function asRole(role: string): Role {
  return role
    .split(",")
    .map((r) => r.trim())
    .includes("owner")
    ? "owner"
    : "member";
}

// Single source of truth is the Drizzle `status` enum column.
export type ProjectStatus = Project["status"];

// Accessible while initializing (the ProjectStore self-heals lazily on
// first access) or ready; denied once broken/deleted.
export const ACCESSIBLE_STATUSES = ["initializing", "ready"] as const;

export function isAccessible(s: ProjectStatus): boolean {
  return s === "initializing" || s === "ready";
}

// Atomic increment so two concurrent destructive events each land a
// distinct bump. Mirrors `bumpOrgProjectsEpoch` in org-lifecycle.ts.
export async function bumpAuthEpoch(
  db: ControlDb,
  projectId: ProjectId,
): Promise<void> {
  await db
    .update(project)
    .set({ authEpoch: sql`${project.authEpoch} + 1` })
    .where(eq(project.id, projectId));
}

export async function markProjectReady(
  db: ControlDb,
  projectId: ProjectId,
): Promise<void> {
  await db
    .update(project)
    .set({ status: "ready" })
    .where(and(eq(project.id, projectId), eq(project.status, "initializing")));
}

export async function markProjectBroken(
  db: ControlDb,
  projectId: ProjectId,
): Promise<void> {
  await db
    .update(project)
    .set({ status: "broken" })
    .where(eq(project.id, projectId));
}
