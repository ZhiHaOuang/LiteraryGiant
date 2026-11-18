# Read-only activity projection

`lib/tui/activity.js` is an internal, dependency-free projection for an optional UI consumer. Existing components do not subscribe to events or change tool behavior. The consumer owns its live `session/event` subscription and disposes the store with its plugin activation.

## Input and scope

Pass the calling `session.id` and committed DSH 0.2.0-rc.2 events to `observe`. Native calls use `tool/call` and `tool/result`; PTC children use `tool/ptc-dispatch-start` and `tool/ptc-dispatch`. Only exact OPS tool names are counted. Outer `run_code` calls and foreign tool names are ignored. Call IDs are opaque and session-local.

Statistics cover events observed since mounting, not complete session history. Sequence numbers deduplicate a live ordered stream; this is not a history replay API. An observer must rebuild rather than accumulate across a replaced history. Durations are observed wall-clock intervals, clamped at zero, not worker CPU time.

## Retention and privacy

Defaults: 32 sessions (LRU), 128 active calls per session, and 8 recent settled rows. Consumers may lower or raise these within the module limits. At active capacity, new calls are omitted and the snapshot reports `limited`; tracked work can still settle. Session eviction drops statistics only and never stops work. No input, command, pattern, replacement, path, result body, or error text is retained.

Snapshots are immutable and referentially stable until that session changes. Subscribers cannot alter snapshots or interfere with one another. Disposal releases all state and subscriptions.

## Meaning of a return

`returned` means the tool transport returned without a host error; it does **not** mean an operation succeeded. OPS can return structured `status: error/rejected` values without throwing. UI consumers must not render a neutral return as a successful mutation. No token savings, model-visible output volume, or background-job completion is inferred.

## Native result diagnostics

For OPS file and PTC tools only, `result.js` reads outcome facts from one of two sources. A Native top-level result carries them in the host's replayable presentation metadata (`meta.opsOutcome`, produced by `presentationMeta` in `src/kernel/presentation-outcome.ts`), because Native model text is compact prose rather than JSON. A PTC child result is a single JSON text envelope of at most 64 KiB (serialized UTF-8 bytes). It retains only known outcome categories, safe nonnegative counters, boolean flags and a bounded uppercase error code. Raw text, items, paths and error messages are discarded. Host failure cannot be upgraded to confirmed success. Shell prose and spilled/malformed output remain business-unconfirmed. Explicit unknown effects are distinguished from merely unavailable business status. No result reference is followed and no progress percentage or token saving is inferred.

## Verification

```console
node test/run.mjs tui-activity
```

The fixtures follow public DSH event fields; they are synthetic, not a captured Windows execution. No Rust worker, model key, or user profile is required.
