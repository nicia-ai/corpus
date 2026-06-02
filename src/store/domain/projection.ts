import {
  decodeEvent,
  type InstrumentationEvent,
} from "./instrumentation-events";

// The rebuildable projection over the durable event stream. Pure,
// zero-IO, deterministic — folding the same prefix yields the same
// state. The activity view's freshness derivation, the funnel signals,
// and the per-(caller, collection) last-read all derive from this; no
// consumer reads the event_log table directly.
//
// **Invariant:** the projection is a fold-only view of appended events.
// Nothing in the system mutates projection state independently of an
// event append; dropping the cache and rebuilding from the log MUST
// yield the same result. Pinned by a prefix-vs-whole equivalence test.
//
// Scope is event-stream-only signals. Cross-plane signals (e.g. "second
// human invited", which lives in Better Auth's invitation table) are
// the activity view's job to combine with this projection downstream.

// What an EventLogStore row decodes to from the projection's POV.
// The fold is fed envelopes; the typed event lives in `event` and
// the envelope's monotonic id / timestamp surround it.
export type ProjectionInput = Readonly<{
  monotonicId: number;
  timestamp: string;
  event: InstrumentationEvent;
}>;

// Per-(caller, collection) state — the activity view's freshness
// derivation reads this. `Fresh` = the caller's most recent read
// captured the collection's current versions; `Stale` = a later edit
// has landed since (caller-current `versionCapturedAtRead` is older
// than the collection's current versions). This projection records the
// evidence; rendering the chip is the activity view's job.
export type CallerCollectionState = Readonly<{
  callerRef: string;
  collectionSlug: string;
  lastReadAt: string;
  lastReadMonotonicId: number;
  versionCapturedAtRead: Readonly<Record<string, number>>;
}>;

// The event-stream-derivable funnel signals. Each is a wedge-defining
// moment from the office-hours design doc; ISO timestamps so the
// activity view can show "first happened at" without re-deriving.
// `undefined` = "has not happened yet in this project's stream."
export type FunnelSignals = Readonly<{
  // First MCP read by any caller against any collection (first agent
  // contact moment).
  firstMcpReadAt: string | undefined;
  // First read.after-edit event — the wedge-proof moment ("agent
  // read the teammate's edit").
  firstReadAfterEditAt: string | undefined;
  // When the second distinct CallerRef connected (the team-rollout
  // signal — going from 1 → 2 callers is the wedge).
  secondDistinctCallerConnectedAt: string | undefined;
  // Count of distinct CallerRefs that have appeared in the stream
  // (caller.connected OR any read attributed to them).
  distinctCallerCount: number;
  // Post-activation prompt: the user's chosen bet (undefined until
  // a prompt.answered event lands). The funnel kill-signal value.
  promptBet:
    | "shared-prompts-skills"
    | "version-quality-measurement"
    | "off-laptop-reactivity"
    | "policy-change-approval"
    | "none"
    | undefined;
  promptAnsweredAt: string | undefined;
}>;

// The full derived state — what the projection cache holds and what
// the activity-view server fn consumes.
export type ProjectionState = Readonly<{
  funnel: FunnelSignals;
  // Keyed by "<callerRef>|<collectionSlug>" so iteration order is stable
  // and two callers reading the same collection never alias. The Map
  // preserves insertion order — useful for "recent activity" surfaces
  // — and is cheap to clone-on-write.
  perCallerCollection: ReadonlyMap<string, CallerCollectionState>;
  // Distinct CallerRefs that have appeared in the stream so far.
  // Tracked independently of perCallerCollection because a caller can
  // appear via caller.connected (no collection yet) before any read
  // resolves a collection; using the map alone would double-count that
  // caller's first subsequent read as "a new caller".
  seenCallers: ReadonlySet<string>;
}>;

const KEY_SEP = "|";

export function callerCollectionKey(
  callerRef: string,
  collectionSlug: string,
): string {
  return `${callerRef}${KEY_SEP}${collectionSlug}`;
}

const EMPTY_FUNNEL: FunnelSignals = {
  firstMcpReadAt: undefined,
  firstReadAfterEditAt: undefined,
  secondDistinctCallerConnectedAt: undefined,
  distinctCallerCount: 0,
  promptBet: undefined,
  promptAnsweredAt: undefined,
};

export const EMPTY_PROJECTION: ProjectionState = {
  funnel: EMPTY_FUNNEL,
  perCallerCollection: new Map(),
  seenCallers: new Set(),
};

// Apply one event to a projection state, returning the new state.
// Pure: same (state, event) always yields the same result. The fold
// below is just a left-reduce of this; pulled out so consumers can
// also apply a single just-appended event without re-folding the
// whole log.
export function applyEvent(
  state: ProjectionState,
  input: ProjectionInput,
): ProjectionState {
  const { event, timestamp } = input;
  switch (event.type) {
    case "read": {
      const key = callerCollectionKey(event.callerRef, event.collectionSlug);
      const nextMap = new Map(state.perCallerCollection);
      nextMap.set(key, {
        callerRef: event.callerRef,
        collectionSlug: event.collectionSlug,
        lastReadAt: timestamp,
        lastReadMonotonicId: input.monotonicId,
        versionCapturedAtRead: event.versionCapturedAtRead,
      });
      const seen = state.seenCallers.has(event.callerRef);
      const nextSeen = seen
        ? state.seenCallers
        : new Set([...state.seenCallers, event.callerRef]);
      return {
        funnel: {
          ...state.funnel,
          firstMcpReadAt: state.funnel.firstMcpReadAt ?? timestamp,
          firstReadAfterEditAt:
            event.kind === "after-edit"
              ? (state.funnel.firstReadAfterEditAt ?? timestamp)
              : state.funnel.firstReadAfterEditAt,
          ...bumpDistinctCallers(state.funnel, seen, timestamp),
        },
        perCallerCollection: nextMap,
        seenCallers: nextSeen,
      };
    }
    case "caller.connected": {
      const seen = state.seenCallers.has(event.callerRef);
      const nextSeen = seen
        ? state.seenCallers
        : new Set([...state.seenCallers, event.callerRef]);
      return {
        funnel: {
          ...state.funnel,
          ...bumpDistinctCallers(state.funnel, seen, timestamp),
        },
        perCallerCollection: state.perCallerCollection,
        seenCallers: nextSeen,
      };
    }
    case "prompt.answered": {
      // Only the FIRST answer per project counts as the funnel
      // signal — subsequent answers (e.g. a team member changing
      // their mind, dismiss-then-re-prompt) are recorded in the log
      // but the funnel value sticks: one team, one answer.
      if (state.funnel.promptAnsweredAt !== undefined) return state;
      return {
        ...state,
        funnel: {
          ...state.funnel,
          promptBet: event.bet,
          promptAnsweredAt: timestamp,
        },
      };
    }
    // Document and collection lifecycle events flow through the stream
    // but the projection does not derive funnel state from them
    // directly — the activity view's per-collection "last edit" comes
    // from the DocumentVersion chain (existing source of truth), not
    // from these events. They are kept in the stream for the audit
    // log and future stream consumers.
    case "document.created":
    case "document.updated":
    case "document.renamed":
    case "document.archived":
    case "document.filename_changed":
    case "collection.created":
    case "collection.updated":
    case "collection.attached":
    case "collection.detached":
    case "collection.reordered":
      return state;
  }
}

// Fold the full event sequence (or an incremental tail) into a
// projection state. Order MUST be ascending monotonic-id; the caller
// (a repo wrapping the EventLogStore.iterate()) guarantees this.
//
// Rebuildability invariant: foldEvents(allEvents) === foldEvents(
//   allEvents.slice(0, K), EMPTY) → foldEvents(allEvents.slice(K)).
// The unit tests pin this.
export function foldEvents(
  inputs: readonly ProjectionInput[],
  prior: ProjectionState = EMPTY_PROJECTION,
): ProjectionState {
  return inputs.reduce(applyEvent, prior);
}

// Convenience: decode an EventLogStore envelope (where `payload` is
// a JSON string of an InstrumentationEvent) into a ProjectionInput.
// Throws on a malformed payload — the fold should not silently skip
// rows; the caller decides whether to halt or log-and-continue.
export function toProjectionInput(
  envelope: Readonly<{
    monotonicId: number;
    timestamp: string;
    payload: string;
  }>,
): ProjectionInput {
  return {
    monotonicId: envelope.monotonicId,
    timestamp: envelope.timestamp,
    event: decodeEvent(envelope.payload),
  };
}

function bumpDistinctCallers(
  funnel: FunnelSignals,
  alreadySeen: boolean,
  timestamp: string,
): Partial<FunnelSignals> {
  if (alreadySeen) return {};
  const distinctCallerCount = funnel.distinctCallerCount + 1;
  return {
    distinctCallerCount,
    // Latch the "second distinct caller" moment — the team-rollout
    // wedge signal. Never overwrites (the `?? timestamp` would
    // otherwise reset on later distinct callers).
    secondDistinctCallerConnectedAt:
      distinctCallerCount === 2 &&
      funnel.secondDistinctCallerConnectedAt === undefined
        ? timestamp
        : funnel.secondDistinctCallerConnectedAt,
  };
}
