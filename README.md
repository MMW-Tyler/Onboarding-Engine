# MMW OnboardEngine

A resilient, AI-augmented orchestrator for client onboarding and on-demand
account setup. **One always-on program** on Render, built entirely on tools MMW
already uses (Supabase · Render · GitHub · Zapier).

See the full build specification (`OnboardEngineBuildSpec` v4) for the complete
design. This README covers the current build state and how to run it.

## How it works (plain language)

There is one program, always on. It does two things:

1. **Listens (the doorbell).** Zapier pings `/webhook/intake` or
   `/webhook/clientform` when a form is submitted. The engine writes the client
   and the full checklist of steps into Supabase.
2. **Works the checklist.** The same program polls a `jobs` table in Supabase,
   claims the next ready step, runs it (talking to each service's API directly),
   checks it off, and unblocks dependents — over and over.

No Redis. No separate database. Supabase *is* the state store + the checklist.

## Architecture

```
Zapier / dashboard ──► one always-on Render service ──► Supabase
                       (web + checklist loop)           (runs, steps, events, jobs)
```

- `src/index.ts` — Express app: webhooks, run API, dashboard endpoints; starts the loop.
- `src/engine/loop.ts` — the checklist loop (claims jobs via `claim_next_job`).
- `src/engine/runner.ts` — the generic step-runner (modes, safety classes, retry, idempotency).
- `src/engine/runs.ts` — create runs, enqueue ready steps, promote/block dependents, reruns.
- `src/steps/` — the step catalog (M1 ships the `echo.*` test steps).
- `src/redact.ts` — strips secrets + sensitive client keys before any event is logged.
- `db/schema.sql` — the four Supabase tables + the `claim_next_job()` function.
- `prompts/*.md` — the six versioned Anthropic prompts (used from M4 on).

## Run modes & safety classes (spec section 04)

- **`RUN_MODE`**: `dry` (default) or `live`. One global toggle (env + `POST /mode`).
- **read-safe** steps run for real in both modes.
- **reversible-write** steps are *simulated* in dry-run (status `simulated`).
- **costly** steps (Namecheap purchase) never write in dry-run, and in live need a
  two-key unlock (`NAMECHEAP_LIVE=true` **and** a per-run confirmation token).

## Local setup

```bash
npm install
cp .env.example .env          # fill in SUPABASE_URL + SUPABASE_SERVICE_KEY at minimum
# apply the schema to your Supabase project:
#   paste db/schema.sql into the Supabase SQL editor, or
#   psql "$SUPABASE_DB_URL" -f db/schema.sql
npm run dev
```

Then exercise the M1 lifecycle (no real services touched):

```bash
# Happy path — reversible-write steps simulate, read-safe runs for real:
curl -X POST localhost:10000/runs -H 'content-type: application/json' \
  -d '{"recipe":"echo_demo","client":{"name":"Test Co"}}'

# Failure path — root fails past its retry budget -> flagged, child -> blocked:
curl -X POST localhost:10000/runs -H 'content-type: application/json' \
  -d '{"recipe":"echo_demo","input":{"echo":{"root":{"failTimes":9}}}}'

curl localhost:10000/runs                 # list
curl localhost:10000/runs/<id>            # detail: run + step grid + events
curl -X POST localhost:10000/runs/<id>/steps/echo.root/retry   # rerun
curl localhost:10000/status               # mode + step/job tallies
```

## Scripts

| script | does |
| --- | --- |
| `npm run dev` | watch-mode dev server (`tsx`) |
| `npm run build` | compile TypeScript to `dist/` |
| `npm start` | run the compiled server (Render uses this) |
| `npm run typecheck` | type-check only |
| `npm test` | run unit tests (`vitest`) |

## Build status

- **M1 — engine + checklist + log: implemented.** Express app, Supabase schema,
  checklist loop, generic step-runner (modes, safety classes, retry/idempotency,
  redaction), echo test steps, run API + minimal status endpoints, `render.yaml`.
- M2 — dashboard UI + real read-safe/reversible workers (dry-run harness): next.
- M3 — recipes + first live reversible test.
- M4 — forms + Slack profile (Prompts 1–2), Wave 1 live.
- M5 — Wave 2 AI (Prompts 3–6) + Namecheap live behind the two-key unlock.
