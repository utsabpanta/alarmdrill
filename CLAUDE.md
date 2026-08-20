# CLAUDE.md

`alarmdrill` — injects known faults, checks whether the monitoring caught them, grades observability. See `SPEC.md`.

## pnpm only

Never npm or yarn. No `package-lock.json` should exist.

```bash
pnpm install
pnpm add <dep> --filter @alarmdrill/core   # per-package
pnpm add -Dw <dep>                          # root tooling
pnpm -r typecheck && pnpm test               # before declaring done
pnpm lab:up / lab:down
```

Shared dep versions go in the workspace catalog, referenced as `catalog:`. Cross-package deps use `workspace:*`. Phantom dependency errors get fixed by declaring the dep, never by `node-linker=hoisted`.

## Hard rules

1. `packages/observers` must never import `packages/injectors` — that's how ground truth leaks into the evidence bundle. ESLint enforces it; restructure rather than disable.
2. Nothing about the injected fault reaches a diagnostician prompt. Not the name, not the config, not the injection timestamp.
3. `revert()` is idempotent. It will be called twice.
4. Journal before injecting. An unjournaled injection is an orphan waiting to happen.
5. No test calls a real model. No test depends on wall-clock timing.
6. Zod at every external boundary — config, Alertmanager responses, LLM output. Never trust a model's output shape.
7. Never widen a safety guard to make a test pass.

## Style

TypeScript strict, ESM, no `any` (use `unknown` and narrow). Typed errors per package, mapped to exit codes at the CLI boundary only. Prompts live in `packages/agents/prompts/` as versioned files. No barrel files except each package's `src/index.ts`.

Conventional Commits, scoped: `feat(injectors): add http status fault`.

## Working style

- One milestone at a time. Stop at the boundary and report what landed, what's tested, and anything that diverged from SPEC.md.
- Disagree with a spec decision? Say so once with the tradeoff, then follow it unless overridden.
- Unsure of an API shape (Toxiproxy, Docker Engine, Prometheus, Anthropic SDK)? Say so. Don't guess — that's this project's main failure mode.
- If SPEC.md goes stale, propose the edit rather than silently diverging.
