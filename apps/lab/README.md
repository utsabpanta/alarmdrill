# lab

The demo system alarmdrill drills against. A small coffee shop: a gateway, a
checkout that writes orders and charges cards, a payments service in front of a
mock PSP, and a catalog that reads through Redis to Postgres.

```
                    ┌──────────┐
  loadgen ────────▶ │ gateway  │
                    └────┬─────┘
              ┌──────────┴──────────┐
              ▼                     ▼
        ┌──────────┐          ┌──────────┐
        │ checkout │          │ catalog  │
        └────┬─────┘          └────┬─────┘
             │ ⟿ toxiproxy         │ ⟿ toxiproxy
             ▼                     ▼
        ┌──────────┐         ┌─────────┐   ┌──────────┐
        │ payments │         │  redis  │   │ postgres │
        └────┬─────┘         └─────────┘   └──────────┘
             │ ⟿ toxiproxy         ▲            ▲
             ▼                     └── cache ───┘
        ┌──────────┐                  fallback
        │ psp-mock │
        └──────────┘
```

`⟿` marks a hop that runs through Toxiproxy, which is where M2 attaches network
faults. Prometheus scrapes the five services every 5s; Alertmanager holds the
firing alerts that M3's observers will read.

```bash
pnpm lab:up      # docker compose up -d --wait
pnpm lab:down    # and remove volumes
```

| | |
|---|---|
| gateway | http://localhost:3000 |
| psp-mock control | http://localhost:3003/_control/decline-rate |
| Toxiproxy API | http://localhost:8474 |
| Prometheus | http://localhost:9090 |
| Alertmanager | http://localhost:9093 |

## Planted blind spots

**This file is the authoritative record of every deliberate gap in the lab's
alert rules. A gap is only allowed to exist if it is written down here first.**
An undocumented gap is a bug in the lab, not a finding about the tool.

`src/planted-gaps.test.ts` asserts that the rules in `prometheus/alerts.yml` and
the metrics defined in `src/metrics.ts` still match what this section claims.
Change either one without changing this file and the build fails.

The target grade is around a **C**. An F means the lab is a strawman; an A means
it has nothing left to teach.

| Fault | Detected? | Mechanism | Why |
|---|---|---|---|
| Stop `payments` | ✅ fast | `ServiceDown` | Scrape fails, `up == 0`. Positive control — if this ever stops working, the harness is broken, not the lab. |
| +800ms `checkout` → `payments` | ✅ | `GatewayHighLatency` | p95 at the edge crosses 500ms. The alert says the shop is slow and names no dependency, so it is detected but close to useless for diagnosis. |
| **Stop `redis`** | ❌ | — | `catalog` falls back to Postgres and returns 200s. `catalog_cache_lookups_total{result="error"}` climbs and **no rule reads it**. Flagship blind spot. |
| Saturate the DB pool | ⚠️ late | `GatewayHighLatency` | `db_pool_connections{state="waiting"}` climbs immediately and **no rule reads it**. Only surfaces once queueing pushes edge latency past an unrelated threshold. |
| **PSP declines 60%** | ❌ | — | psp-mock returns HTTP 200 for a decline; `payments` records the outcome nowhere. **The metric does not exist.** |
| Harmless 200ms blip | ➖ | `HighMemoryUsage` only | Stays under the 500ms latency threshold. The chronically-firing memory alert is firing, as always. Must score as **undetected**. |

### Why the last two matter

They are the reason this lab exists rather than a simpler one.

**PSP declines** forces the report to distinguish *"write this rule"* from
*"you must instrument this first."* No PromQL can find a signal that was never
recorded. If a future change adds a `payments_charges_total{outcome=...}`
counter, that finding disappears and the demo gets worse.

**The harmless blip** tests whether alarmdrill measures alert *value* or alert
*volume*. An alert is firing during that experiment. It is the wrong alert, it
was already firing beforehand, and it says nothing about what happened. Scoring
that as a detection would be the single easiest way for this tool to be
comfortably, confidently wrong.

### What is instrumented but unalerted

These metrics exist and no rule reads them. Faults that only show here are
"write this rule" findings:

- `catalog_cache_lookups_total{result="hit"|"miss"|"error"}`
- `db_pool_connections{state="total"|"idle"|"waiting"}`

### What is not instrumented at all

Nothing anywhere in the lab records payment outcomes. Faults that would only
show here are "go instrument this" findings — see `src/services/payments.ts`.

### What is not monitored at all

Redis and Postgres have no exporters and are not scraped. Nobody is watching the
datastores directly, which is why stopping Redis produces no `up == 0` anywhere.

## Alert rules that do exist

| Alert | Fires on | Note |
|---|---|---|
| `ServiceDown` | `up == 0` for 15s | The one rule that works properly. |
| `GatewayHighLatency` | edge p95 > 500ms for 1m | Cannot name a dependency. |
| `GatewayErrorRate` | > 5% 5xx for 1m | Blind to 200-with-a-bad-outcome. |
| `HighMemoryUsage` | RSS > 25MB for 30s | **Chronically firing.** Threshold is below a healthy Node process. Deliberate noise. |
