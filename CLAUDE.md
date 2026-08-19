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

## ClickUp objects per client (2026-08-13)

Three separate ClickUp things get created per Wave 1 run - don't confuse them:

1. **`clickup.clone_template`** — the client's ongoing work FOLDER, cloned from
   the folder template into the template space (SEO / Account Management / Ads
   Coordination / ... lists + the Master Record doc). Stored on
   `onboarding_runs.clickup_folder_id`.
2. **`clickup.onboarding_list`** — **Practice Pro clients only.** Duplicates the
   list "Practice Pro - Onboarding Sample" (`901711324840`) into the folder
   "New Client Onboarding" (`90176700365`, space "Onboarding | Offboarding") and
   names it for the client — the same place `Kale MD`, `Sereno Sante`, etc. live.
   ClickUp's public API has **no duplicate-list endpoint** and the sample is not
   saved as a list template, so the step creates an empty list in the folder and
   re-creates every source task in it (name, description, status, priority,
   tags, dates, `Assigned Role`, and subtask parents). It paces writes at
   ~700 ms to stay under ClickUp's 100 req/min limit, so a full copy of the ~73
   sample tasks takes about a minute. It is resume-safe: a same-named list in
   the folder is reused and tasks already there (matched by name) are skipped,
   so a retry after a partial copy finishes the job instead of duplicating.
   Overridable via `CLICKUP_ONBOARDING_FOLDER_ID` / `CLICKUP_PRACTICE_PRO_LIST_ID`
   (both optional, defaulted to the live ids, so no Render config is needed).
   Smart Start / Whiz Works have no sample list yet — the step reports `skipped`
   for them. Add one and give it a config id when they do.
3. **`clickup.master_tracker`** — the row in the Master Account Tracker list
   (`CLICKUP_MASTER_TRACKER_LIST_ID`). The task name is **just the client name**
   (not "Onboarding - <client>"), and its custom fields are filled from the
   agreement type + deliverables.

### Where the tracker's deliverable fields come from

`src/lib/packages.ts` holds the package matrix: for each program (Smart Start /
Practice Pro / Whiz Works) the "Contract Type" option, the standard monthly
price, and the tracker's deliverable dropdowns (SEO Services, Blogs, GBP
Optimization/Posting, Citations, Press Releases, E-Mail Marketing (+ Platform),
Dr. Social Whiz Access, Events & Webinars, Lead Magnet, Lead Gen Ads Management,
Reputation Management, MMW Hosting, GHL Subaccount, Top Doctor Magazine
Feature, DFY Social Media, Video Services). **Source of truth is the 2026
program agreements in Drive** (`Smart_Start_Agreement (2026)`,
`Practice_Pro_Agreement (2026)`, `Whiz_Works_Agreement (2026)`, Exhibit A) —
update the table when a program's scope changes. Cadences the dropdowns can't
express (2 blogs/mo, 1 event a year, graphic-design projects) go into the
tracker's Notes field, along with the intake's "special additions".

The step never writes a hardcoded field/option UUID: it reads the tracker
list's live field definitions and matches by **name**, so a renamed field or
option shows up as a warn (`fields_unresolved` in the step output) instead of
silently writing garbage. Run-derived fields: Lifecycle=Onboarding, City/State
from NAP, Monthly Committment (intake invoice amount, else the program's list
price), Contract Signed (intake timestamp), Renewal Date (start date + contract
length), Website CMS (from `crawl.detect_platform`), MMW Built Website (from the
intake's website build type). Account Executive, Happiness Level, Maintenance
Level and the meeting dates are deliberately left blank — a human sets those.
The `Address` (location) field is also left alone: ClickUp needs lat/lng for it
and `lib/places.ts` doesn't return coordinates.

## Production URL + Zapier wiring (IMPORTANT - stop asking the user for this)

- **Live service URL: `https://onboarding-engine-h299.onrender.com`**
  (dashboard at `/`, webhooks at `/webhook/intake` and `/webhook/clientform`).
- **Phase one (Sales Intake form, Wave 1):** Zapier zap is LIVE. Google Form ->
  Webhooks by Zapier POST to `/webhook/intake`, JSON, fields mapped BY HAND in
  the zap. Leave that zap's style alone.
- **Phase two (Client MMW Onboarding form, Wave 2):** zap posts to
  `/webhook/clientform`. Header `X-MMW-Secret` = value of `MMW_WEBHOOK_SECRET`
  from the Render dashboard.
- **CORRECTION (2026-07-17): "leave the Data section empty" does NOT forward
  question-text-keyed fields — it was never actually verified against a real
  payload, and it's wrong.** Confirmed from a real webhook log: with Data left
  empty, Zapier forwards the RAW Google Forms API response - answers keyed by
  internal 8-char `questionId` hashes (`"18459843"`, `"28998979"`, ...) plus
  API metadata (`id`, `createTime`, `responseId`, `lastSubmittedTime`), not
  question text. The label normalizer can't map any of that (confirmed: 0/40
  fields mapped on a real attempt, AI fallback caught 0/40 too). **Do not
  trust this zap is wired correctly until you've seen the normalizer actually
  map a real submission's fields — check the dashboard run's
  `profile.normalize_clientform` step output for `mapped_keys` after a live
  test; if it's empty, the zap still needs fixing.**
  Likely fix (UNVERIFIED, try before assuming): switch the trigger from
  "Google Forms - New Form Response" to "Google Sheets - New Spreadsheet Row"
  pointed at the same linked responses sheet (the CSV export IS that sheet),
  since Sheets' API returns column-header-keyed rows rather than Forms'
  internal ID-keyed answers - that should give question text as keys without
  hand-mapping 40 fields. Then insert the trigger step's whole row as the
  webhook's JSON body rather than individual fields. Test and inspect one real
  payload before calling it done.

## Phase two scope: the form goes to Slack, and that's it (2026-08-19, Tyler)

- The Client MMW onboarding form was originally the trigger for a Wave 2 research
  chain. **That's retired.** Tyler: the engine shouldn't intermingle with the
  tools the team already uses - no Advice Local listing submissions, no keyword
  research. **The process stops once the onboarding form has been delivered to
  the client's Slack channel.**
- `/webhook/clientform` now attaches exactly two steps to the matching Wave 1
  run: `profile.normalize_clientform` -> `slack.post_clientform_profile`
  (recipe `clientform_delivery`). The old bundle (gbp.optimize_plan,
  crawl.site_report, dataforseo.pull, seo.roadmap, research.press_topics,
  research.content_calendar, advicelocal.listings, ghl.a2p_registration,
  wave2.rollup) is still registered and still selectable by hand in the
  dashboard as the `wave2_research` recipe - nothing fires it on its own.
- `slack.post_clientform_profile` is built so the form CANNOT get stuck:
  - normalize is a **soft** dependency, so the broken-zap case (0/40 fields
    mapped - see the Zapier note above) still posts every answer verbatim with a
    banner saying the labels didn't come through as question text.
  - a run with no `slack_channel_id` (submission didn't match a Wave 1 run)
    posts to `SLACK_FALLBACK_CHANNEL_ID` with a "couldn't match this to a client
    channel" banner instead of parking the data in the DB unseen.
  - it only pins the message in the client's own channel, never in the fallback.
- Open question left for Tyler: `ghl.a2p_registration` went out with the research
  chain because it ran after the form. If 10DLC registration should still happen
  automatically, it belongs in Wave 1, not here.

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

## Bad website answers on the intake form (2026-08-12)

- The Sales Intake form's Website URL field gets filled in wrong regularly - a
  live run stalled because the rep typed an **email address** there. Everything
  domain-shaped reads `client_profile_json.website_url`, so it is now resolved
  once, in `profile.normalize_intake`, via `websiteHostFrom()` in
  `src/lib/domain.ts`: a work email yields its host (`info@foo.com` -> `foo.com`),
  a real site typed next to an email wins over the email, and a personal mailbox
  (`...@gmail.com`) or junk yields **nothing** - `website_url` is left unset and
  the step logs a warn rather than storing a bogus value.
- `namecheap.purchase_domain`'s base label goes through the same resolver plus a
  `NON_BRAND_LABELS` blocklist, so a personal-email answer can never spend money
  on `gmailpx.com` / `facebookpx.com`; it falls back to slugging the practice name.
- **To fix a stranded run:** dashboard run detail -> **fix website** (or
  `POST /runs/:id/website {"website":"example.com"}`), then **resume**. It sets
  `profile.website_url`, and `onboarding_runs.domain` too *only* while
  `namecheap.purchase_domain` is still outstanding - once a domain is purchased
  that column is the domain we actually own DNS for and must not be overwritten.

## Why platform detection kept coming back "unknown" (2026-08-12)

- **The main bug: `crawl.detect_platform` read `ctx.run.domain` first.** It and
  `namecheap.purchase_domain` both depend only on `profile.normalize_intake`, so
  they are enqueued together and `claim_next_job` orders by `run_after` (all
  equal) - the order is effectively arbitrary. Whenever the purchase won the
  race it overwrote `run.domain` with the just-registered `<base>px.com`, and the
  crawler fingerprinted a domain with no site on it. **Always read
  `profile.website_url` first** for anything that looks at the client's existing
  site; `run.domain` is the domain WE own, not theirs. `crawl.site_report` had
  this right already - `detect_platform` now matches it.
- Both crawlers now fetch through `fetchSite()` in `src/lib/site.ts`, which
  ladders `https://apex -> https://www -> http://apex -> http://www`, sends
  browser-shaped headers (WAFs 403 an obviously-scripted user-agent), and checks
  `res.ok`. The old code did one https-apex request with a bot UA and never
  checked the status, so a challenge page or a 404 got scored like real HTML and
  surfaced as "unknown".
- A failed read now reports *which* failure (`dns_error`, `tls_error`,
  `http_403`, `timeout`, ...) plus every URL tried, in the run's technical log.
  When the page reads fine but nothing matches, the step falls back to the
  `<meta name="generator">` value and logs a warn - "unknown" now really means
  unknown, not "we never got the page".

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
- `CLICKUP_ONBOARDING_FOLDER_ID` -> defaults `90176700365` ("New Client
  Onboarding" folder).
- `CLICKUP_PRACTICE_PRO_LIST_ID` -> defaults `901711324840` ("Practice Pro -
  Onboarding Sample" list).
- `NAMECHEAP_REGISTRANT_COUNTRY` -> defaults `US`.
- `GHL_BRANDED_DNS_HOST` / `_TYPE` / `_TARGET` -> default `go` / `CNAME` /
  `brand.ludicrous.cloud` (the MMW standard GHL branded-domain CNAME).
