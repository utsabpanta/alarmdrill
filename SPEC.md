# alarmdrill

## The problem

Every team writes alert rules and then assumes they work. Nobody tests that assumption.

You find out your alerting has a hole during an incident, at 3am, when the thing that broke was the thing you had no rule for. The gap is usually not exotic — a cache falls back to the database so nothing errors, a payment starts declining but returns HTTP 200, a connection pool saturates and only shows up as latency somewhere three services downstream.

Chaos engineering tools (Chaos Monkey, Gremlin, Chaos Mesh) break things to check the **system** survives. None of them check whether your **monitoring would have told you**.

## What we're building

A CLI that injects a known fault into a running system, watches what the monitoring actually did, then hands the resulting alerts and metrics to a **blinded LLM agent** that must diagnose the fault without being told what it is.

Because we injected the fault, we know the right answer. So we can automatically score whether the telemetry was good enough for a competent responder to diagnose from.

Output: which failure modes are invisible, how long detection took, which alerts fired but were useless, and PromQL rules to close the gaps.

```bash
alarmdrill run --suite baseline

  [1/4] latency: checkout → payments +800ms
        detected 76s · diagnosis ✓ correct
  [2/4] dependency down: redis
        detected never · ✗ BLIND SPOT

  Grade: C+ (detection 3/4 · diagnosis 2/4)
```

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict), Node 22, ESM | — |
| Monorepo | pnpm workspaces + catalogs | pnpm only — never npm/yarn |
| CLI | commander | |
| Validation | zod | Config files and **all** LLM output |
| Logging | pino | |
| Tests | vitest + testcontainers | |
| Network faults | Toxiproxy (HTTP API) | Latency, timeouts, resets |
| Container faults | Docker Engine API via dockerode | Stop, pause, CPU/mem limits |
| Metrics | Prometheus + Alertmanager | Read-only; we don't replace them |
| Lab services | Fastify + prom-client | |
| Lab runtime | Docker Compose | K8s is post-1.0 |
| LLM | Anthropic SDK | Behind one interface, with a fake for tests |

Use the APIs, not the CLIs — shelling out makes cleanup unreliable, and reliable cleanup is a safety property here.

## Packages

```
packages/core         orchestration, run lifecycle, scoring
packages/injectors    toxiproxy, docker, http-fault
packages/observers    alertmanager + prometheus → evidence bundle
packages/agents       planner, diagnostician, grader
packages/report       markdown output
packages/cli          published binary
apps/lab              demo system with deliberately imperfect alerts
```

## Two things that must not break

**1. Blinding.** The diagnostician sees only what an on-call engineer would: firing alerts, metrics, logs. Never the fault name, the injector config, or the injection timestamp — knowing the exact second something changed is most of a diagnosis.

If this leaks, it fails silently: the tool reports excellent observability for systems that have none. Enforce with a package boundary (`observers` must never import `injectors`), a single `buildEvidenceBundle()` constructor, and a test asserting no injector vocabulary reaches the prompt.

**2. Cleanup.** We break things on purpose.

- `revert()` is idempotent — it gets called by the happy path, the error path, a deadman timer, and crash recovery
- Journal the injection to disk *before* applying it; sweep orphans on startup
- Deadman timer reverts unconditionally after `maxDuration` (default 120s)
- SIGINT/SIGTERM revert everything, then exit non-zero
- Explicit target allowlist; refuse to run against anything matching prod patterns
- One fault at a time

## Build order

| | | |
|---|---|---|
| **M0** | Scaffold | pnpm workspace, TS strict, CI green |
| **M1** | Lab | Compose: gateway → checkout → payments → psp-mock, catalog, Postgres, Redis, Toxiproxy, Prometheus. Alert rules deliberately incomplete — document which gaps are planted. |
| **M2** | Injectors + safety | Toxiproxy + Docker injectors. All cleanup guarantees above. Test: SIGKILL mid-injection, restart, assert reverted. |
| **M3** | Observers | Poll Alertmanager, compute MTTD and detection rate, build the evidence bundle |
| **M4** | Diagnostician | Blinded agent + grader + full run traces to disk. `replay` re-grades offline. |
| **M5** | Planner | Reads topology + existing rules, proposes experiments ranked by suspected blind spot |
| **M6** | Report | **The demo.** Blind spot found → proposed rule → re-run detects it. Record it. |
| **M7** | CLI + CI mode | `--json`, exit non-zero below threshold |
| **M8** | Ship | npm, README, blog post |

Stop after M6 if time runs short — that's the whole story. M7/M8 are packaging.

## Planted blind spots in the lab

The lab must grade around C, not F. Some faults caught cleanly, some invisible — and every gap deliberate and documented in `apps/lab/README.md`.

| Fault | Detected? | Why |
|---|---|---|
| Stop `payments` | ✅ fast | `ServiceDown` fires. Positive control. |
| +800ms checkout→payments | ✅ | Latency alert fires but doesn't name the dependency |
| **Stop `redis`** | ❌ | Catalog falls back to Postgres, returns 200s, no cache alert. Flagship blind spot. |
| Saturate DB pool | ⚠️ late | Only when latency crosses an unrelated threshold |
| **PSP declines 60%** | ❌ | Returns HTTP 200. **The metric doesn't exist** — needs instrumentation, not a rule. |
| Harmless 200ms blip | ➖ | Only the chronically-noisy memory alert fires. Must score as *undetected*. |

Those last two are the interesting output. One forces the report to distinguish "add this rule" from "you must instrument this first." The other tests whether we're measuring alert *value* or just alert *volume*.

## Decisions already made

- **Bedrock of the pitch is blinding.** Everything else is scaffolding around it.
- **Prompts are versioned files**, not inline strings. Old runs were graded under old prompts.
- **No test calls a real model or depends on wall-clock time.** Fake LLM, injected clock.
- **Grader runs N=3, take the mode.** Report disagreement rate; mark `needs_review` on a three-way split.
- **Scope:** not a resilience tester, not a hosted service, not Kubernetes, not multi-cloud.

## Open questions

- Should the diagnostician query Prometheus iteratively like a real responder, or get a single evidence dump? Iterative measures *discoverability*, not just alert quality — better product, more complexity. Start single-shot.
- Calendar vs rolling windows for detection scoring.
- Auto-open a PR with proposed rules, or just print them?
