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
  redaction), echo test steps, run API, `render.yaml`.
- **M2 — dashboard + workers: implemented.** Dashboard UI (grid, trigger panel,
  event feed, rerun, dry/live toggle). All Wave 1 integration workers built with
  live + dry paths: Slack, HubSpot, ClickUp, Drive, Namecheap (sandbox), DNS,
  Mailgun, Warmup, GHL.
- **M3 — recipes + partial runs: implemented.** `full_onboarding`,
  `device_client_setup`, `ghl_only`, `domain_warmup_only`, `wave2_research`
  recipes; hand-selected steps supported.
- **M4 — forms + Slack profile: implemented.** Zapier webhooks create runs;
  Prompts 1–2 normalize both forms (deterministic table + AI fallback);
  sensitive fields (NPI/DEA/license/credentials) routed to a restricted bucket
  and redacted on all API output; Slack channel + profile post + pinned
  client-profile.json. Run all in dry-run to validate, then flip `RUN_MODE=live`.
- **M5 — Wave 2 AI + research: implemented.** Prompts 3–6 (GBP optimization plan,
  crawl→brand/SEO report, SEO roadmap, press topics + content calendar) as DRAFTs;
  Google Places + multi-page crawl + DataForSEO inputs; Advice Local listings;
  GHL A2P registration (stub pending snapshot field map); wave2.rollup posts a
  review summary to Slack. Wave 2 is attached to the Wave 1 run by the clientform
  webhook (reuses channel + phase0 gate + GHL location). Namecheap live still
  behind the two-key unlock; the domain/email stack can be pinned dry in live via
  STEP_DRY_OVERRIDE.

The dashboard is styled to the MMW aesthetic (Fraunces / Space Mono / Newsreader,
cream-paper palette). Several M5 external calls (DataForSEO, Advice Local, GHL
A2P, Google Places) are best-effort vs documented APIs and carry TODO/verify
markers — validate in dry-run, then one controlled live test each.

> Live API calls for non-Slack integrations were written against documented APIs
> but are **unverified** until exercised with real credentials. Workers carry
> `TODO` markers where provider-specific details (registrant info, DKIM values,
> GHL endpoints/version, Warmup Inbox API, ClickUp template cloning) need
> confirmation. Validate each in dry-run first, then one controlled live test.
