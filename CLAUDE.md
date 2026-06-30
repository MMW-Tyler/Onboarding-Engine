# OnboardEngine — project notes for Claude

## Branch / deploy workflow (IMPORTANT)

- **Commit and push directly to `main`.** Render deploys from `main`, and that is
  the only branch the user can see/select in Render. Do NOT develop on a separate
  `claude/*` feature branch and wait to merge — work goes straight to `main` so it
  shows up on Render. This is the user's standing instruction and overrides the
  default "develop on a feature branch" convention.
- Every push to `main` auto-deploys to Render, so keep `main` working: run
  `npm run typecheck`, `npm run build`, and `npm test` before pushing.

## Deploy setup (managed by the user, not in code)

- Render: one always-on web service, branch `main`, defined by `render.yaml`.
- Supabase: apply `db/schema.sql` in the SQL editor. Set `SUPABASE_URL` and
  `SUPABASE_SERVICE_KEY` (plus other integration vars) in the Render dashboard,
  not in a local `.env` (the user does not build locally).

## Project shape

See `README.md` for architecture and `OnboardEngineBuildSpec` v4 for the full
design. Build proceeds in milestones M1..M5 (see README "Build status").

## Render env vars currently configured (as of 2026-06-30)

These are SET in the Render dashboard (values not in repo). Treat this as the
source of truth for what config exists in prod. When adding a `required()`
getter, it must be in this list or prod will crash on boot.

Core / infra: `PORT`, `RUN_MODE`, `LOOP_INTERVAL_MS`, `JOB_CLAIM_TIMEOUT_MS`,
`MMW_WEBHOOK_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ANTHROPIC_API_KEY`.

Slack: `SLACK_BOT_TOKEN`, `SLACK_FALLBACK_CHANNEL_ID`.
HubSpot: `HUBSPOT_ACCESS_TOKEN`, `HUBSPOT_PORTAL_ID` (= 6186303).
ClickUp: `CLICKUP_API_TOKEN`, `CLICKUP_TEAM_ID` (= 9017400250),
`CLICKUP_MASTER_TRACKER_LIST_ID`, `CLICKUP_FOLDER_TEMPLATE_ID`,
`CLICKUP_TEMPLATE_SPACE_ID`, `CLICKUP_TEMPLATE_LIST_ID`.
Drive: `GDRIVE_SA_JSON`, `CLIENTS_PARENT_FOLDER_ID`, `CLIENTS_TEMPLATE_FOLDER_ID`.
GHL: `GHL_API_KEY`, `GHL_COMPANY_ID`, `GHL_SNAPSHOT_ID`.
Namecheap: `NAMECHEAP_API_KEY`, `NAMECHEAP_API_USER`, `NAMECHEAP_BASE_URL`,
`NAMECHEAP_CLIENT_IP`, `NAMECHEAP_LIVE`, `NAMECHEAP_RELAY_URL`,
`NAMECHEAP_RELAY_SECRET`, plus registrant: `NAMECHEAP_REGISTRANT_FIRST_NAME`,
`_LAST_NAME`, `_ORGANIZATION`, `_ADDRESS1`, `_CITY`, `_STATE`, `_POSTAL_CODE`,
`_PHONE`, `_EMAIL`.
Mailgun: `MAILGUN_API_KEY`, `MAILGUN_REGION`.
Warmup: `WARMUPINBOX_API_KEY`, `WARMUPINBOX_ROTATION_INBOXES`.
DataForSEO: `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`.
Other: `GOOGLE_PLACES_API_KEY`, `ADVICELOCAL_API_KEY`, `STEP_DRY_OVERRIDE`.

NOT set, relying on code defaults (do not assume these exist):
- `NAMECHEAP_REGISTRANT_COUNTRY` -> defaults `US`.
- `GHL_BRANDED_DNS_HOST` / `_TYPE` / `_TARGET` -> default `go` / `CNAME` /
  `brand.ludicrous.cloud` (the MMW standard GHL branded-domain CNAME).
