import type { EventLogStore } from "@/event-log-store";
import type { CollectionSlug } from "@/ids";
import {
  decodeEvent,
  type InstrumentationEvent,
} from "@/store/domain/instrumentation-events";
import {
  EMPTY_PROJECTION,
  foldEvents,
  type ProjectionInput,
  toProjectionInput,
} from "@/store/domain/projection";

export type ActivityStatus = "fresh" | "stale" | "awaiting";

export type ActivityAgentRow = Readonly<{
  callerRef: string;
  callerLabel: string;
  authPath: "apikey" | "oauth";
  lastReadAt: string;
  versionCapturedAtRead: Readonly<Record<string, number>>;
  status: ActivityStatus;
  staleVersionMap?: Readonly<
    Record<string, Readonly<{ captured: number; current: number }>>
  >;
}>;

export type RecentEventRow = Readonly<{
  monotonicId: number;
  eventType: string;
  timestamp: string;
  description: string;
}>;

export type ActivityDTO = Readonly<{
  collectionSlug: string;
  contextName: string;
  mcpUrl: string;
  lastEditAt: string | undefined;
  lastEditBy: string | undefined;
  hasAnyAgents: boolean;
  agents: readonly ActivityAgentRow[];
  recentActivity: readonly RecentEventRow[];
  promptVisible: boolean;
  promptAnswered: boolean;
}>;

type ActivityStore = Readonly<{
  collectionStructure: (slug: CollectionSlug) => Promise<
    | { found: false }
    | {
        found: true;
        name: string;
        members: readonly Readonly<{ slug: string; docVersion: number }>[];
      }
  >;
}>;

type EventEnvelope = Readonly<{
  monotonicId: number;
  schemaVersion: number;
  projectId: string;
  idempotencyKey: string;
  eventType: string;
  timestamp: string;
  payload: string;
}>;

type EventLogPort = Pick<DurableObjectStub<EventLogStore>, "iterate">;

function labelFor(callerRef: string): {
  callerLabel: string;
  authPath: "apikey" | "oauth";
} {
  if (callerRef.startsWith("apikey:")) {
    const id = callerRef.slice("apikey:".length);
    return {
      callerLabel: `API key · ${id.slice(0, 8)}…`,
      authPath: "apikey",
    };
  }
  if (callerRef.startsWith("oauth:")) {
    const sub = callerRef.slice("oauth:".length);
    return {
      callerLabel: `User · ${sub.slice(0, 8)}…`,
      authPath: "oauth",
    };
  }
  return { callerLabel: callerRef, authPath: "apikey" };
}

function describeEvent(event: InstrumentationEvent): string {
  switch (event.type) {
    case "document.created":
      return `${event.changedBy} created ${event.slug}`;
    case "document.updated":
      return `${event.changedBy} edited ${event.slug} (v${String(event.docVersion)})`;
    case "document.renamed":
      return `${event.changedBy} renamed ${event.slug}`;
    case "document.archived":
      return `${event.changedBy} archived ${event.slug}`;
    case "document.filename_changed":
      return `${event.changedBy} changed filename of ${event.slug}`;
    case "collection.created":
      return `${event.changedBy} created collection ${event.collectionSlug}`;
    case "collection.updated":
      return `${event.changedBy} edited collection ${event.collectionSlug}`;
    case "collection.attached": {
      const what = event.documentSlug ?? event.folderSlug ?? "a member";
      return `${event.changedBy} attached ${what} to ${event.collectionSlug}`;
    }
    case "collection.detached": {
      const what = event.documentSlug ?? event.folderSlug ?? "a member";
      return `${event.changedBy} detached ${what} from ${event.collectionSlug}`;
    }
    case "collection.reordered":
      return `${event.changedBy} reordered ${event.collectionSlug}`;
    case "read":
      return event.kind === "first"
        ? `${labelFor(event.callerRef).callerLabel} first read of ${event.collectionSlug}`
        : `${labelFor(event.callerRef).callerLabel} read ${event.collectionSlug} after an edit`;
    case "caller.connected":
      return `${labelFor(event.callerRef).callerLabel} connected`;
    case "prompt.answered":
      return `${event.answeredBy} answered post-activation prompt: ${event.bet}`;
  }
}

const RECENT_LIMIT = 20;

function deriveStatus(
  versionCapturedAtRead: Readonly<Record<string, number>>,
  currentVersions: ReadonlyMap<string, number>,
): {
  status: ActivityStatus;
  staleVersionMap?: Record<string, { captured: number; current: number }>;
} {
  if (currentVersions.size === 0) return { status: "awaiting" };
  let drift: Record<string, { captured: number; current: number }> | undefined;
  for (const [slug, current] of currentVersions) {
    const captured = versionCapturedAtRead[slug] ?? 0;
    if (captured < current) {
      drift ??= {};
      drift[slug] = { captured, current };
    }
  }
  return drift === undefined
    ? { status: "fresh" }
    : { status: "stale", staleVersionMap: drift };
}

function isActivated(
  distinctEditors: Set<string>,
  distinctAgentCallers: number,
  hasPostInviteEdit: boolean,
): boolean {
  return (
    distinctEditors.size >= 2 && distinctAgentCallers >= 1 && hasPostInviteEdit
  );
}

const ITERATE_PAGE = 1000;
const ITERATE_MAX_PAGES = 50;

async function iterateAll(
  log: EventLogPort,
): Promise<readonly EventEnvelope[]> {
  const all: EventEnvelope[] = [];
  let cursor: number | undefined;
  for (let page = 0; page < ITERATE_MAX_PAGES; page += 1) {
    const opts =
      cursor === undefined
        ? { limit: ITERATE_PAGE }
        : { sinceMonotonicId: cursor, limit: ITERATE_PAGE };
    const rows = await log.iterate(opts);
    if (rows.length === 0) break;
    for (const r of rows) all.push(r);
    cursor = rows[rows.length - 1]?.monotonicId;
    if (rows.length < ITERATE_PAGE) break;
  }
  return all;
}

function tryProjectionInput(
  envelope: EventEnvelope,
): ProjectionInput | undefined {
  try {
    return toProjectionInput(envelope);
  } catch (err) {
    console.warn("[activity] skipped undecodable event_log row (projection)", {
      monotonicId: envelope.monotonicId,
      schemaVersion: envelope.schemaVersion,
      eventType: envelope.eventType,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function includesActivityContext(
  evt: InstrumentationEvent,
  slug: CollectionSlug,
): boolean {
  return (
    ("collectionSlug" in evt && evt.collectionSlug === slug) ||
    evt.type === "caller.connected" ||
    evt.type === "prompt.answered" ||
    evt.type === "document.created" ||
    evt.type === "document.updated" ||
    evt.type === "document.renamed" ||
    evt.type === "document.archived"
  );
}

export async function buildCollectionActivity(
  args: Readonly<{
    slug: CollectionSlug;
    mcpUrl: string;
    store: ActivityStore;
    log: EventLogPort;
  }>,
): Promise<ActivityDTO> {
  const { slug, mcpUrl, store, log } = args;
  const structure = await store.collectionStructure(slug);
  const currentVersions = new Map<string, number>();
  let contextName: string = slug;
  if (structure.found) {
    contextName = structure.name;
    for (const m of structure.members) {
      currentVersions.set(m.slug, m.docVersion);
    }
  }

  const envelopes = await iterateAll(log);
  const inputs: ProjectionInput[] = [];
  for (const env of envelopes) {
    const input = tryProjectionInput(env);
    if (input !== undefined) inputs.push(input);
  }
  const projection = foldEvents(inputs, EMPTY_PROJECTION);

  const agents: ActivityAgentRow[] = [];
  const distinctAgentCallers = new Set<string>();
  for (const s of projection.perCallerCollection.values()) {
    if (s.collectionSlug !== slug) continue;
    const { callerLabel, authPath } = labelFor(s.callerRef);
    const { status, staleVersionMap } = deriveStatus(
      s.versionCapturedAtRead,
      currentVersions,
    );
    agents.push({
      callerRef: s.callerRef,
      callerLabel,
      authPath,
      lastReadAt: s.lastReadAt,
      versionCapturedAtRead: s.versionCapturedAtRead,
      status,
      ...(staleVersionMap === undefined ? {} : { staleVersionMap }),
    });
    distinctAgentCallers.add(s.callerRef);
  }
  agents.sort((a, b) => {
    if (a.status !== b.status) {
      if (a.status === "stale") return -1;
      if (b.status === "stale") return 1;
    }
    return b.lastReadAt.localeCompare(a.lastReadAt);
  });

  const recentActivity: RecentEventRow[] = [];
  const distinctEditors = new Set<string>();
  let lastEditAt: string | undefined;
  let lastEditBy: string | undefined;
  let hasPostInviteEdit = false;
  for (let i = envelopes.length - 1; i >= 0; i -= 1) {
    const env = envelopes[i];
    if (env === undefined) continue;
    let evt: InstrumentationEvent;
    try {
      evt = decodeEvent(env.payload);
    } catch (err) {
      console.warn("[activity] skipped undecodable event_log row", {
        monotonicId: env.monotonicId,
        schemaVersion: env.schemaVersion,
        eventType: env.eventType,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!includesActivityContext(evt, slug)) continue;
    if (recentActivity.length < RECENT_LIMIT) {
      recentActivity.push({
        monotonicId: env.monotonicId,
        eventType: env.eventType,
        timestamp: env.timestamp,
        description: describeEvent(evt),
      });
    }
    if (
      evt.type === "document.created" ||
      evt.type === "document.updated" ||
      evt.type === "document.renamed"
    ) {
      distinctEditors.add(evt.changedBy);
      if (lastEditAt === undefined) {
        lastEditAt = env.timestamp;
        lastEditBy = evt.changedBy;
      }
      if (distinctEditors.size >= 2) {
        hasPostInviteEdit = true;
      }
    }
  }

  const promptAnswered = projection.funnel.promptAnsweredAt !== undefined;
  const promptVisible =
    !promptAnswered &&
    isActivated(distinctEditors, distinctAgentCallers.size, hasPostInviteEdit);

  return {
    collectionSlug: slug,
    contextName,
    mcpUrl,
    lastEditAt,
    lastEditBy,
    hasAnyAgents: agents.length > 0 || distinctAgentCallers.size > 0,
    agents,
    recentActivity,
    promptVisible,
    promptAnswered,
  };
}
