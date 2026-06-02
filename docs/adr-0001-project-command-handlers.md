# ADR 0001: Project Command Handlers

## Status

Accepted.

## Context

`ProjectStore` is the aggregate boundary for one Project. It owns the only
atomic write boundary because TypeGraph graph data and the Drizzle ledger share
the Durable Object SQLite handle. Splitting document, collection, folder, or
bundle writes across Durable Objects would weaken that guarantee.

The implementation had grown around private `*Body` methods that already acted
like proto-command handlers: they accepted the active unit of work plus a clock
value, performed repository orchestration, and returned the changes to emit
after commit. The missing piece was a single contract for new handlers.

## Decision

Keep `ProjectStore` as the Durable Object RPC shell, lifecycle owner, and
transaction owner. Move application use cases into command handlers over time.

A command handler:

- accepts a `ProjectCommandContext`;
- performs all graph/ledger-neutral orchestration through the provided
  `ProjectUnit`;
- returns `CommandOutcome<T>` with `{ result, changes }`;
- does not append `change_events` directly;
- does not call the cross-DO `EventLogStore`;
- composes by calling other command handlers with the same context and
  concatenating their ordered `changes`.

`ProjectStore` records returned changes inside the same `write()` transaction:

1. append the local `change_events` ledger row;
2. enqueue the corresponding instrumentation event into the transactional
   outbox;
3. preserve the returned change order as the canonical causal order.

The outbox is drained after commit and by Durable Object alarm retry. Duplicate
delivery is handled by the EventLogStore idempotency key, but FIFO drain
stop-on-first-failure preserves causal order.

## Consequences

The public Durable Object method surface stays stable. Handler modules are
plain TypeScript and can be tested without introducing a DI container or
command-bus library.

Read projections remain computed for now. Materialized projections are deferred
until a measured read-path bottleneck justifies the drift/rebuild complexity.
