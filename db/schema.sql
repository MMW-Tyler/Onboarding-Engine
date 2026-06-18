-- MMW OnboardEngine - Supabase (Postgres) schema
-- Spec section 06 (data model) + section 07 (the checklist loop).
-- Supabase IS Postgres: this holds all run/step state, the visible error log,
-- and the checklist of jobs. No Redis, no separate database.
--
-- Apply with: psql "$SUPABASE_DB_URL" -f db/schema.sql
-- or paste into the Supabase SQL editor.

create extension if not exists pgcrypto;  -- for gen_random_uuid()

-- ---------------------------------------------------------------------------
-- onboarding_runs : one row per onboarding/account-setup run
-- ---------------------------------------------------------------------------
create table if not exists onboarding_runs (
  id                   uuid primary key default gen_random_uuid(),
  client_name          text,
  package              text,
  recipe               text not null,
  mode                 text not null default 'dry' check (mode in ('dry','live')),
  domain               text,
  hubspot_company_id   text,
  ghl_location_id      text,
  slack_channel_id     text,
  drive_root_folder_id text,
  clickup_folder_id    text,
  wave1_status         text not null default 'pending',
  wave2_status         text not null default 'pending',
  phase0_complete      boolean not null default false,
  raw_intake_json      jsonb,
  raw_clientform_json  jsonb,
  client_profile_json  jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- run_steps : the per-run step state machine
-- ---------------------------------------------------------------------------
create table if not exists run_steps (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references onboarding_runs(id) on delete cascade,
  step_key        text not null,
  wave            smallint,                       -- 1, 2, or null (utility step)
  safety_class    text not null check (safety_class in ('read-safe','reversible-write','costly')),
  status          text not null default 'pending'
                    check (status in ('pending','running','succeeded','failed','flagged','blocked','skipped','simulated')),
  attempts        int not null default 0,
  max_attempts    int not null default 3,
  depends_on      text[] not null default '{}',
  last_error      text,
  output_json     jsonb,
  idempotency_key text not null,
  clickup_task_id text,
  updated_at      timestamptz not null default now(),
  unique (run_id, step_key)
);

create index if not exists run_steps_run_idx    on run_steps(run_id);
create index if not exists run_steps_status_idx on run_steps(status);

-- ---------------------------------------------------------------------------
-- step_events : append-only visible error/activity log (spec section 10)
-- one row per attempt per external call
-- ---------------------------------------------------------------------------
create table if not exists step_events (
  id               uuid primary key default gen_random_uuid(),
  run_id           uuid not null references onboarding_runs(id) on delete cascade,
  step_key         text not null,
  attempt          int not null default 0,
  ts               timestamptz not null default now(),
  level            text not null default 'info' check (level in ('info','warn','error')),
  mode             text,
  endpoint         text,
  request_redacted jsonb,        -- secrets stripped by the redaction helper before insert
  response_status  int,
  response_body    jsonb,
  parsed_error     text,
  duration_ms      int
);

create index if not exists step_events_run_idx on step_events(run_id, ts desc);
create index if not exists step_events_lvl_idx on step_events(level);

-- ---------------------------------------------------------------------------
-- jobs : the checklist the always-on loop reads (spec section 07)
-- ---------------------------------------------------------------------------
create table if not exists jobs (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid not null references onboarding_runs(id) on delete cascade,
  step_key   text not null,
  status     text not null default 'queued' check (status in ('queued','claimed','done','failed')),
  run_after  timestamptz not null default now(),   -- backoff scheduling
  claimed_at timestamptz,
  attempts   int not null default 0,
  created_at timestamptz not null default now(),
  unique (run_id, step_key)
);

create index if not exists jobs_claimable_idx on jobs(status, run_after);

-- ---------------------------------------------------------------------------
-- claim_next_job() : atomically claim one ready job.
-- Uses FOR UPDATE SKIP LOCKED so the claim is safe even if the loop ever
-- runs in more than one copy (spec section 07, step 2).
-- A job claimed but never finished becomes reclaimable after p_timeout_ms,
-- so nothing is ever stranded (spec section 07, step 4).
-- ---------------------------------------------------------------------------
create or replace function claim_next_job(p_timeout_ms int default 300000)
returns setof jobs
language plpgsql
as $$
declare
  v_job jobs;
begin
  select * into v_job
  from jobs
  where (
          (status = 'queued' and run_after <= now())
          or (status = 'claimed' and claimed_at < now() - make_interval(secs => p_timeout_ms / 1000.0))
        )
  order by run_after asc
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  update jobs
     set status = 'claimed',
         claimed_at = now(),
         attempts = jobs.attempts + 1
   where id = v_job.id
   returning * into v_job;

  return next v_job;
end;
$$;
