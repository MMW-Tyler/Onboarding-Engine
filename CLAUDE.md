# OnboardEngine — project notes for Claude

## Branch / deploy workflow (IMPORTANT)

- **Commit and push directly to `main`.** Render deploys from `main`, and that is
  the only branch the user can see/select in Render. Do NOT develop on a separate
  `claude/*` feature branch and wait to merge — work goes straight to `main` so it
  shows up on Render. This is the user's standing instruction and overrides the
  default "develop on a feature branch" convention.
- Every push to `main` auto-deploys to Render, so keep `main` working: run
  `npm run typecheck`, `npm run build`, and `npm test` before pushing.

## Runtime defaults (IMPORTANT)

- **Default RUN_MODE is `live`.** The engine runs for real unless RUN_MODE=dry is
  set or the dashboard toggle is flipped to dry ("maintenance mode").
- **Domain purchases auto-authorize.** The only gate on the costly
  namecheap.purchase_domain step is NAMECHEAP_LIVE=true. There is no per-run
  confirmation token (onboarding forms arrive unpredictably; a manual click per
  purchase was an unwanted bottleneck). Spend is bounded by the $20 price guard
  (NAMECHEAP_MAX_PRICE) + the availability check + the fixed domain pattern
  (<base>px.com then <base>patients.com). To stop all purchases, set
  NAMECHEAP_LIVE=false or RUN_MODE=dry.

## Production URL + Zapier wiring (IMPORTANT - stop asking the user for this)

- **Live service URL: `https://onboarding-engine-h299.onrender.com`**
  (dashboard at `/`, webhooks at `/webhook/intake` and `/webhook/clientform`).
- **Phase one (Sales Intake form, Wave 1):** Zapier zap is LIVE. Google Form ->
  Webhooks by Zapier POST to `/webhook/intake`, JSON, fields mapped BY HAND in
  the zap. Leave that zap's style alone.
- **Phase two (Client MMW Onboarding form, Wave 2):** zap posts to
  `/webhook/clientform` with the Data section left EMPTY so Zapier forwards all
  form fields verbatim (question text as JSON keys - that is what the label
  normalizer expects). Header `X-MMW-Secret` = value of `MMW_WEBHOOK_SECRET`
  from the Render dashboard. The hand-mapped intake zap and this pass-through
  zap are intentionally different styles; do not "fix" either to match the other.

## Phase two decisions (2026-07-16, from Tyler)

- **No backfill** of historical client-form responses; new submissions only.
- The client form has changed over the years. The **most recent ~20 responses
  (Dec 2025 onward) are the source of truth** for the current field set. No
  longer collected (legacy columns only): email address column, Facebook /
  Instagram / LinkedIn URLs, 12-month goals, referral questions, lunch spots,
  chamber of commerce, years of experience, and two of the three office-hours
  variants. The live hours question is "What are your office hours that you
  want listed online?".
- **Validate the NAP office address against Google Places** during value
  normalization (`GOOGLE_PLACES_API_KEY` is set) - clients make typos (real
  example: Sereno's ZIP "950032" should be 95032).
- **First live test client: Sereno** (Sereno Pain Management Medical Group,
  provider Maia Chakerian MD). They submitted the form on 7/16/2026 BEFORE the
  zap existed, so the zap will never fire for their row. The controlled live
  test = manually replay their form row as a POST to `/webhook/clientform`
  once phase-two hardening is done.
- **Found via the Wave 1 run log (2026-07-17): Sereno's `onboarding_runs.domain`
  is `serenosantepx.com`, not `serenosante.com`.** `serenosante.com` wasn't
  available at purchase time, so namecheap.purchase_domain bought the `px.com`
  fallback and overwrote `onboarding_runs.domain` with it (this is normal,
  documented behavior - see "Runtime defaults" above). Sereno's Wave 2 form
  answer for their website is `serenosante.com` (their real, intended domain -
  same as what they typed in Wave 1, preserved in
  `client_profile_json.website_url`). This is NOT Sereno-specific: any client
  whose first-choice domain wasn't available at Wave 1 purchase time will have
  this same domain/website_url split. `webhooks.ts`'s `findRunIdByDomain` now
  falls back to matching on `client_profile_json.website_url` when the exact
  `domain` match fails, specifically to handle this. There is a suspicious
  unnamed `wave2_research` run in the dashboard (created 5:37 PM, after
  Sereno's 4:23 PM form submission) that looks like fallout from this exact
  mismatch on a prior manual attempt - worth checking before assuming a fresh
  replay will attach cleanly.

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
