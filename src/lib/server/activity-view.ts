import type { EventLogStore } from "@/event-log-store";
import { type CollectionSlug, parseCallerRef } from "@/ids";
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
  // Decode through the single sanctioned parser; this function only owns the
  // display formatting (truncation), not the prefix vocabulary.
  const { kind, id } = parseCallerRef(callerRef);
  if (kind === "apikey") {
    return { callerLabel: `API key · ${id.slice(0, 8)}…`, authPath: "apikey" };
  }
  if (kind === "oauth") {
    return { callerLabel: `User · ${id.slice(0, 8)}…`, authPath: "oauth" };
  }
  return { callerLabel: callerRef, authPath: "apikey" };
}

// Resolve an author id to its display name for the feed. The event log
// stores opaque user ids; the control plane owns the id → name mapping
// (resolveUserNames), injected into the builder as a plain lookup so
// this stays port-driven. Unresolvable ids (deleted account, sentinel
// "" / "import") fall back to the raw stored value.
function describeEvent(
  event: InstrumentationEvent,
  names: ReadonlyMap<string, string>,
): string {
  const who = (id: string): string => names.get(id) ?? id;
  switch (event.type) {
    case "document.created":
      return `${who(event.changedBy)} created ${event.slug}`;
    case "document.updated":
      return `${who(event.changedBy)} edited ${event.slug} (v${String(event.docVersion)})`;
    case "document.renamed":
      return `${who(event.changedBy)} renamed ${event.slug}`;
    case "document.archived":
      return `${who(event.changedBy)} archived ${event.slug}`;
    case "document.filename_changed":
      return `${who(event.changedBy)} changed filename of ${event.slug}`;
    case "collection.created":
      return `${who(event.changedBy)} created collection ${event.collectionSlug}`;
    case "collection.updated":
      return `${who(event.changedBy)} edited collection ${event.collectionSlug}`;
    case "collection.attached": {
      const what = event.documentSlug ?? event.folderSlug ?? "a member";
      return `${who(event.changedBy)} attached ${what} to ${event.collectionSlug}`;
    }
    case "collection.detached": {
      const what = event.documentSlug ?? event.folderSlug ?? "a member";
      return `${who(event.changedBy)} detached ${what} from ${event.collectionSlug}`;
    }
    case "collection.reordered":
      return `${who(event.changedBy)} reordered ${event.collectionSlug}`;
    case "read":
      return event.kind === "first"
        ? `${labelFor(event.callerRef).callerLabel} first read of ${event.collectionSlug}`
        : `${labelFor(event.callerRef).callerLabel} read ${event.collectionSlug} after an edit`;
    case "caller.connected":
      return `${labelFor(event.callerRef).callerLabel} connected`;
    case "prompt.answered":
      return `${who(event.answeredBy)} answered post-activation prompt: ${event.bet}`;
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

// Bulk id → display-name lookup, injected by the transport (the server
// fn wires resolveUserNames against the control DB; tests wire a map).
export type NameResolver = (
  ids: readonly string[],
) => Promise<ReadonlyMap<string, string>>;

export async function buildCollectionActivity(
  args: Readonly<{
    slug: CollectionSlug;
    mcpUrl: string;
    store: ActivityStore;
    log: EventLogPort;
    resolveNames: NameResolver;
  }>,
): Promise<ActivityDTO> {
  const { slug, mcpUrl, store, log, resolveNames } = args;
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

  // Two passes over the feed: collect the display window first, then
  // resolve every author id in one bulk lookup before formatting — the
  // descriptions are plain strings, so names must be applied at build
  // time, not render time.
  const display: { env: EventEnvelope; evt: InstrumentationEvent }[] = [];
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
    if (display.length < RECENT_LIMIT) {
      display.push({ env, evt });
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

  const authorIds = new Set<string>();
  for (const { evt } of display) {
    if ("changedBy" in evt) authorIds.add(evt.changedBy);
    if (evt.type === "prompt.answered") authorIds.add(evt.answeredBy);
  }
  if (lastEditBy !== undefined) authorIds.add(lastEditBy);
  const names = await resolveNames([...authorIds]);

  const recentActivity: RecentEventRow[] = display.map(({ env, evt }) => ({
    monotonicId: env.monotonicId,
    eventType: env.eventType,
    timestamp: env.timestamp,
    description: describeEvent(evt, names),
  }));

  const promptAnswered = projection.funnel.promptAnsweredAt !== undefined;
  const promptVisible =
    !promptAnswered &&
    isActivated(distinctEditors, distinctAgentCallers.size, hasPostInviteEdit);

  return {
    collectionSlug: slug,
    contextName,
    mcpUrl,
    lastEditAt,
    lastEditBy:
      lastEditBy === undefined
        ? undefined
        : (names.get(lastEditBy) ?? lastEditBy),
    hasAnyAgents: agents.length > 0 || distinctAgentCallers.size > 0,
    agents,
    recentActivity,
    promptVisible,
    promptAnswered,
  };
}
