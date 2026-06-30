import { db } from '../supabase.js';
import { getStep, hasStep } from '../steps/registry.js';
import { recipeSteps } from '../recipes.js';
import { defaultMaxAttempts, defaultProfileFor } from './retry.js';
import { clearEchoBudget } from '../steps/echo.js';
import type { RunMode } from '../config.js';
import { getRunMode } from '../config.js';
import type { RunStep, StepStatus } from '../types.js';

/** Step statuses that satisfy a dependency (a downstream step may proceed). */
const SATISFIED: ReadonlySet<StepStatus> = new Set<StepStatus>(['succeeded', 'simulated', 'skipped']);
/** Step statuses that permanently break a dependency (downstream gets blocked). */
const BROKEN: ReadonlySet<StepStatus> = new Set<StepStatus>(['failed', 'flagged', 'blocked']);

export interface CreateRunArgs {
  recipe: string;
  /** explicit step keys override the recipe bundle (dashboard hand-select) */
  stepKeys?: string[];
  client?: { name?: string; package?: string; domain?: string };
  mode?: RunMode;
  /** arbitrary intake payload; echo steps read failTimes from input.echo */
  input?: Record<string, unknown>;
  /** raw Client MMW form payload -> raw_clientform_json (Wave 2) */
  clientformInput?: Record<string, unknown>;
}

export interface CreateRunResult {
  runId: string;
  steps: string[];
  queued: string[];
}

/**
 * Create a run: write the run row, one run_steps row per selected step, then
 * enqueue the immediately-ready steps as jobs (spec section 07, step 1).
 */
export async function createRun(args: CreateRunArgs): Promise<CreateRunResult> {
  const stepKeys = args.stepKeys ?? recipeSteps(args.recipe);
  if (!stepKeys || stepKeys.length === 0) {
    throw new Error(`Unknown or empty recipe: ${args.recipe}`);
  }

  // Validate every key is registered before touching the DB.
  const unknown = stepKeys.filter((k) => !hasStep(k));
  if (unknown.length > 0) {
    throw new Error(`Recipe "${args.recipe}" references unregistered steps: ${unknown.join(', ')}`);
  }

  const selected = new Set(stepKeys);
  const mode = args.mode ?? getRunMode();

  const { data: run, error: runErr } = await db()
    .from('onboarding_runs')
    .insert({
      recipe: args.recipe,
      mode,
      client_name: args.client?.name ?? null,
      package: args.client?.package ?? null,
      domain: args.client?.domain ?? null,
      raw_intake_json: args.input ?? {},
      raw_clientform_json: args.clientformInput ?? null,
    })
    .select('id')
    .single();
  if (runErr || !run) throw new Error(`createRun: failed to insert run: ${runErr?.message}`);

  const runId = run.id as string;

  const stepRows = stepKeys.map((key) => {
    const step = getStep(key)!;
    // Only depend on deps that are part of this run's selected set.
    const deps = step.dependsOn.filter((d) => selected.has(d));
    const maxAttempts =
      step.maxAttempts ?? defaultMaxAttempts(step.retryProfile ?? defaultProfileFor(step.safetyClass));
    return {
      run_id: runId,
      step_key: key,
      wave: step.wave,
      safety_class: step.safetyClass,
      status: 'pending' as StepStatus,
      max_attempts: maxAttempts,
      depends_on: deps,
      idempotency_key: `${runId}:${key}`,
    };
  });

  const { error: stepsErr } = await db().from('run_steps').insert(stepRows);
  if (stepsErr) throw new Error(`createRun: failed to insert steps: ${stepsErr.message}`);

  // Enqueue ready steps (no in-run dependencies).
  const ready = stepRows.filter((r) => r.depends_on.length === 0).map((r) => r.step_key);
  if (ready.length > 0) {
    await enqueueJobs(runId, ready);
  }

  return { runId, steps: stepKeys, queued: ready };
}

/**
 * Attach steps to an existing run (used by the Client MMW form webhook to add
 * Wave 2 onto the run created from the Sales Intake form). Inserts any missing
 * run_steps, wiring depends_on to steps already on the run plus the new set, and
 * enqueues the ones whose dependencies are already satisfied. Returns added keys.
 */
export async function addStepsToRun(runId: string, stepKeys: string[]): Promise<string[]> {
  const unknown = stepKeys.filter((k) => !hasStep(k));
  if (unknown.length > 0) throw new Error(`addStepsToRun: unregistered steps: ${unknown.join(', ')}`);

  const { data: existing, error } = await db().from('run_steps').select('step_key, status').eq('run_id', runId);
  if (error) throw new Error(`addStepsToRun: ${error.message}`);
  const statusByKey = new Map<string, StepStatus>((existing ?? []).map((s) => [s.step_key as string, s.status as StepStatus]));

  const toAdd = stepKeys.filter((k) => !statusByKey.has(k));
  if (toAdd.length === 0) return [];

  const selected = new Set<string>([...statusByKey.keys(), ...stepKeys]);
  const rows = toAdd.map((key) => {
    const step = getStep(key)!;
    const deps = step.dependsOn.filter((d) => selected.has(d));
    return {
      run_id: runId,
      step_key: key,
      wave: step.wave,
      safety_class: step.safetyClass,
      status: 'pending' as StepStatus,
      max_attempts: step.maxAttempts ?? defaultMaxAttempts(step.retryProfile ?? defaultProfileFor(step.safetyClass)),
      depends_on: deps,
      idempotency_key: `${runId}:${key}`,
    };
  });
  const { error: insErr } = await db().from('run_steps').insert(rows);
  if (insErr) throw new Error(`addStepsToRun: insert: ${insErr.message}`);

  // Enqueue new steps whose deps are already satisfied on the run.
  const ready = rows
    .filter((r) => r.depends_on.every((d) => SATISFIED.has(statusByKey.get(d) ?? ('pending' as StepStatus))))
    .map((r) => r.step_key);
  if (ready.length > 0) await enqueueJobs(runId, ready);
  return toAdd;
}

/** Insert queued jobs for the given steps (idempotent on (run_id, step_key)). */
export async function enqueueJobs(runId: string, stepKeys: string[]): Promise<void> {
  if (stepKeys.length === 0) return;
  const rows = stepKeys.map((step_key) => ({ run_id: runId, step_key, status: 'queued' }));
  const { error } = await db().from('jobs').upsert(rows, { onConflict: 'run_id,step_key', ignoreDuplicates: true });
  if (error) throw new Error(`enqueueJobs: ${error.message}`);
}

/**
 * After a step reaches a terminal status, look at everything that depends on it
 * and enqueue any dependent whose dependencies are now all satisfied
 * (spec section 09, step 6). Dependents with a broken dependency are marked
 * `blocked` instead (spec section 07/12).
 */
export async function promoteDependents(runId: string, completedStepKey: string): Promise<void> {
  const { data: steps, error } = await db()
    .from('run_steps')
    .select('step_key, status, depends_on')
    .eq('run_id', runId);
  if (error || !steps) throw new Error(`promoteDependents: ${error?.message}`);

  const byKey = new Map<string, { status: StepStatus; depends_on: string[] }>();
  for (const s of steps) {
    byKey.set(s.step_key as string, { status: s.status as StepStatus, depends_on: (s.depends_on as string[]) ?? [] });
  }

  const toEnqueue: string[] = [];
  const toBlock: string[] = [];

  for (const [key, s] of byKey) {
    if (!s.depends_on.includes(completedStepKey)) continue;
    if (s.status !== 'pending') continue; // already running/terminal/blocked

    const depStatuses = s.depends_on.map((d) => byKey.get(d)?.status ?? 'pending');
    if (depStatuses.some((st) => BROKEN.has(st))) {
      toBlock.push(key);
    } else if (depStatuses.every((st) => SATISFIED.has(st))) {
      toEnqueue.push(key);
    }
  }

  if (toBlock.length > 0) {
    await db().from('run_steps').update({ status: 'blocked', updated_at: new Date().toISOString() })
      .eq('run_id', runId).in('step_key', toBlock);
  }
  if (toEnqueue.length > 0) {
    await enqueueJobs(runId, toEnqueue);
  }
}

/**
 * Rerun one step (spec section 10 rerun controls). Resets the step to pending,
 * clears attempts/error, and re-enqueues the job. Idempotent and safe to click
 * repeatedly (spec section 09 idempotency).
 */
export async function retryStep(runId: string, stepKey: string): Promise<void> {
  const step = await loadStep(runId, stepKey);
  if (!step) throw new Error(`retryStep: no such step ${stepKey} on run ${runId}`);
  // Test fixture: clear the echo step's in-memory fail budget so retry gives a
  // clean attempt rather than continuing the persistent failure simulation.
  // No-op for non-echo steps.
  if (stepKey.startsWith('echo.')) clearEchoBudget(runId, stepKey);
  await db().from('run_steps')
    .update({ status: 'pending', attempts: 0, last_error: null, updated_at: new Date().toISOString() })
    .eq('id', step.id);
  // Reset any existing job row, then ensure one is queued now.
  await db().from('jobs')
    .update({ status: 'queued', run_after: new Date().toISOString(), claimed_at: null })
    .eq('run_id', runId).eq('step_key', stepKey);
  await enqueueJobs(runId, [stepKey]);
}

export interface RerunResult {
  runId: string;
  mode: RunMode;
  reset: number;
  queued: string[];
}

/**
 * Re-run an entire existing run in the given mode (default live). Used to turn a
 * run that executed in dry mode into a real one without re-sending the webhook
 * or redoing any upstream (e.g. Zapier) setup.
 *
 * Flips the run's mode, resets every step to a clean `pending` (clearing
 * attempts / last_error / output_json), clears the run-level wave + phase0
 * bookkeeping, drops the run's job rows, then re-enqueues the steps with no
 * in-run dependencies - exactly like a fresh createRun, but reusing the SAME run
 * row and everything stored on it (slack_channel_id, domain, profile, ...).
 *
 * Safe to go live on a previously-dry run: the write steps are find-or-create /
 * search-first (Slack channel, HubSpot company/contacts, ClickUp, Drive), so a
 * live re-run reuses assets that already exist rather than duplicating them, and
 * any pinned-dry steps (the domain/email stack) still simulate.
 */
export async function rerunRun(runId: string, mode: RunMode = 'live'): Promise<RerunResult> {
  const { data: run, error: runErr } = await db()
    .from('onboarding_runs').select('id').eq('id', runId).maybeSingle();
  if (runErr) throw new Error(`rerunRun: ${runErr.message}`);
  if (!run) throw new Error(`rerunRun: no such run ${runId}`);

  const { data: steps, error: stepsErr } = await db()
    .from('run_steps').select('step_key, depends_on').eq('run_id', runId);
  if (stepsErr) throw new Error(`rerunRun: ${stepsErr.message}`);
  if (!steps || steps.length === 0) throw new Error(`rerunRun: run ${runId} has no steps`);

  // Flip mode + reset run-level bookkeeping so phase0 re-gates.
  await db().from('onboarding_runs').update({
    mode,
    phase0_complete: false,
    wave1_status: 'pending',
    wave2_status: 'pending',
    updated_at: new Date().toISOString(),
  }).eq('id', runId);

  // Reset every step to a clean pending state.
  await db().from('run_steps').update({
    status: 'pending', attempts: 0, last_error: null, output_json: null, updated_at: new Date().toISOString(),
  }).eq('run_id', runId);

  // Clear the job queue for this run, then re-enqueue the immediately-ready steps.
  await db().from('jobs').delete().eq('run_id', runId);

  const ready = steps
    .filter((s) => ((s.depends_on as string[]) ?? []).length === 0)
    .map((s) => s.step_key as string);
  if (ready.length > 0) await enqueueJobs(runId, ready);

  return { runId, mode, reset: steps.length, queued: ready };
}

/** Bulk "retry all flagged" for a run (spec section 10). Returns the keys retried. */
export async function retryAllFlagged(runId: string): Promise<string[]> {
  const { data, error } = await db().from('run_steps')
    .select('step_key').eq('run_id', runId).eq('status', 'flagged');
  if (error) throw new Error(`retryAllFlagged: ${error.message}`);
  const keys = (data ?? []).map((r) => r.step_key as string);
  for (const k of keys) await retryStep(runId, k);
  return keys;
}

/**
 * Resume a partially-failed run: retry every step that ended flagged / blocked /
 * failed, leaving succeeded / simulated / skipped steps untouched. The runner's
 * dependency check re-orders them, so a flagged upstream step that cascade-blocked
 * its dependents recovers in one click once the upstream cause is fixed (e.g.
 * after pinning a step dry). Unlike a full re-run it never re-touches completed
 * write steps, so it won't duplicate already-created assets. Returns keys retried.
 */
export async function resumeRun(runId: string): Promise<string[]> {
  const { data, error } = await db().from('run_steps')
    .select('step_key').eq('run_id', runId).in('status', ['flagged', 'blocked', 'failed']);
  if (error) throw new Error(`resumeRun: ${error.message}`);
  const keys = (data ?? []).map((r) => r.step_key as string);
  for (const k of keys) await retryStep(runId, k);
  return keys;
}

/**
 * Re-post a run's roll-up Slack message on demand (dashboard "send roll-up").
 * Re-runs whatever roll-up step the run has (Wave 1 and/or Wave 2), reusing the
 * step's own channel resolution and message-building. Returns the step keys it
 * re-ran; an empty array means the run has no roll-up step (e.g. a domain-only
 * run, which has no Slack channel to post to).
 */
export async function resendRollup(runId: string): Promise<string[]> {
  const { data, error } = await db().from('run_steps')
    .select('step_key').eq('run_id', runId).in('step_key', ['slack.wave1_rollup', 'wave2.rollup']);
  if (error) throw new Error(`resendRollup: ${error.message}`);
  const keys = (data ?? []).map((r) => r.step_key as string);
  for (const k of keys) await retryStep(runId, k);
  return keys;
}

/** Load a single run_steps row. */
export async function loadStep(runId: string, stepKey: string): Promise<RunStep | null> {
  const { data, error } = await db()
    .from('run_steps')
    .select('*')
    .eq('run_id', runId)
    .eq('step_key', stepKey)
    .maybeSingle();
  if (error) throw new Error(`loadStep: ${error.message}`);
  return (data as RunStep) ?? null;
}
