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

Try it against the bundled lab, no API key needed:

```bash
pnpm install && pnpm lab:up
pnpm alarmdrill run --suite suites/baseline.yaml --detect-only
```

`--detect-only` measures what alerted and skips the blinded agent. Drop it and
set `ANTHROPIC_API_KEY` to get the diagnosis and the grade.

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

**Working end to end, not yet published.** `alarmdrill run` drills a suite
against the lab: injecting, measuring detection, reverting, diagnosing and
grading. It has not been published to npm and has not been pointed at a real
production system.

| | | |
|---|---|---|
| ✅ | M0 | pnpm workspace, strict TS, CI |
| ✅ | M1 | the lab, with documented blind spots |
| ✅ | M2 | injectors + cleanup guarantees |
| ✅ | M3 | observers → evidence bundle |
| ✅ | M4 | blinded diagnostician + voting grader, traces, replay |
| ✅ | M5 | planner |
| ✅ | M6 | report — findings, proposed rules, grade |
| ✅ | M7 | run lifecycle, CI thresholds, `--json` |
| 🔨 | M8 | suite format and commands done; npm publishing not |

### What works today

- **The lab.** `pnpm lab:up` brings up 11 containers. Verified: stopping `redis`
  leaves the catalog serving 200s in ~3ms while
  `catalog_cache_lookups_total{result="error"}` climbs and **nothing alerts**;
  stopping `payments` fires `ServiceDown` within ~20s.
- **Injectors**, with journal-before-inject, idempotent revert, a deadman timer
  and a prod-name refusal. Proven by SIGKILLing a process mid-injection and
  sweeping the fault away from the journal alone.
- **Observers** — polling, MTTD, detection rate, and the blinded evidence bundle.
- **Diagnostician and grader**, behind one model interface with a fake. No test
  calls a real model.
- **Planner**, **report** and the **scorecard**.
- **The CLI**, four commands:

  | | |
  |---|---|
  | `run --suite <path>` | drill a suite; `--detect-only` skips the agent, `--json` for CI, `--min-detection`/`--min-diagnosis` gate the exit code |
  | `plan --suite <path>` | rank experiments by suspected blind spot, breaking nothing |
  | `replay <runId>` | re-grade a recorded run against the current grader prompt |
  | `sweep` | revert anything a crashed run left applied |

- **A suite format** (`suites/baseline.yaml`) where ground truth is written down
  by hand. Inferring the right answer from the fault would mean the tool grading
  itself against its own assumptions.

### What does not work yet

**Not on npm.** `alarmdrill` depends on five `workspace:*` packages that are
private, so publishing today would produce a tarball nobody can install. That
needs one of two decisions first: publish all six under the `@alarmdrill` scope,
or bundle them into `dist`. The package metadata is ready for either.

**Only drilled against its own lab.** Nothing here has been pointed at a real
production system, and it has one user. Treat the grades as a demonstration of
the idea, not an audited measurement.

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
pnpm -r typecheck && pnpm test   # 191 unit tests, sub-second
pnpm lint

pnpm lab:up && pnpm test:integration   # needs the lab; ~20s
pnpm lab:down
```

Unit tests never touch the network, a container or a model — a repo-level test
enforces that no test file imports the Anthropic SDK. The integration suite is
kept separate so the unit loop stays fast, and CI runs both.

Conventions, hard rules and house style live in [CLAUDE.md](./CLAUDE.md); the
design and its rationale live in [SPEC.md](./SPEC.md).

## License

MIT
