# alarmdrill

**Your alerts are untested code.** alarmdrill breaks something on purpose, watches
what your monitoring did about it, then makes a blinded LLM agent diagnose the
fault from nothing but the alerts and metrics — the same view an on-call engineer
would have at 3am.

Because we injected the fault, we know the right answer. So we can score whether
the telemetry was good enough to diagnose from, automatically.

```
alarmdrill run --suite baseline

  [1/4] latency: checkout → payments +800ms
        detected 76s · diagnosis ✓ correct
  [2/4] dependency down: redis
        detected never · ✗ BLIND SPOT

  Grade: C+ (detection 3/4 · diagnosis 2/4)
```

Chaos engineering tools break things to check the **system** survives. None of
them check whether your **monitoring would have told you**.

## Why blinding matters

The diagnostician never learns the fault name, the injector config, or the
injection timestamp — knowing the exact second something changed is most of a
diagnosis. If that leaks, the tool fails silently: it reports excellent
observability for systems that have none.

It is enforced three ways: `packages/observers` may never import
`packages/injectors` (ESLint), a test walks the dependency graph and greps the
sources, and pnpm's isolated linking makes the import unresolvable anyway.

## Status

Early. **M0 (scaffold)** and **M1 (lab)** are done and verified; the injectors,
observers, agents and report are not written yet. See the build order in
[SPEC.md](./SPEC.md).

| | | |
|---|---|---|
| ✅ | M0 | pnpm workspace, strict TS, CI |
| ✅ | M1 | the lab, with documented blind spots |
| ✅ | M2 | injectors + cleanup guarantees |
| ✅ | M3 | observers → evidence bundle |
| ✅ | M4 | blinded diagnostician + grader |
| ⬜ | M5 | planner |
| ⬜ | M6 | report — blind spot found, rule proposed, re-run detects it |
| ⬜ | M7–M8 | CLI polish, ship |

## The lab

A deliberately imperfect coffee shop to drill against: gateway → checkout →
payments → psp-mock, plus a catalog reading through Redis to Postgres, wired
through Toxiproxy and scraped by Prometheus.

Its alert rules have holes, and **every hole is deliberate and documented** in
[`apps/lab/README.md`](./apps/lab/README.md) — a test fails the build if the
rules drift from that document. Stopping Redis is invisible (the catalog falls
back and returns 200s). A PSP declining 60% of payments is invisible for a
different reason: the metric does not exist, so no rule could ever catch it.
Telling those two apart is the point.

```bash
pnpm install
pnpm lab:up      # docker compose, ~11 containers
pnpm lab:down
```

Verified behaviour: stop `redis` and the catalog keeps serving 200s in ~3ms
while `catalog_cache_lookups_total{result="error"}` climbs and nothing alerts.
Stop `payments` and `ServiceDown` fires within ~20s.

## Breaking things safely

We break things on purpose, so cleanup is a correctness property rather than a
nicety. Every injection:

- is **journalled to disk before it is applied**, so a process that dies between
  the two still leaves a record of what to undo
- has an **idempotent `revert()`**, because the happy path, the error path, a
  deadman timer and crash recovery all call it, and more than one routinely fires
- is covered by a **deadman timer** that reverts unconditionally after
  `maxDuration` (120s by default), whatever else has gone wrong
- reverts on **SIGINT/SIGTERM**, then exits non-zero — an interrupted drill
  produced no verdict, and CI must not read that as a pass
- must name a target that is both **explicitly allowlisted** and does not look
  like production; deny beats allow, so an allowlist entry cannot authorise
  `payments-prod`

Only one fault runs at a time. Two concurrent faults make the diagnosis
ambiguous and the blast radius unbounded.

The guarantee is tested the only way worth testing it: a child process journals
a fault, applies it, and is **SIGKILLed** — no handlers, no `finally` blocks — and
a fresh session then reverts it using nothing but the journal on disk.

## Development

Requires Node 22 and pnpm 10. **pnpm only** — never npm or yarn.

```bash
pnpm -r typecheck && pnpm test   # unit tests, sub-second
pnpm lint

pnpm lab:up && pnpm test:integration   # needs the lab running
```

Conventions, hard rules and house style live in [CLAUDE.md](./CLAUDE.md); the
design and its rationale live in [SPEC.md](./SPEC.md).

## License

MIT
