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
