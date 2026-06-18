import { db } from '../supabase.js';
import { getStep, hasStep } from '../steps/registry.js';
import { recipeSteps } from '../recipes.js';
import { defaultMaxAttempts, defaultProfileFor } from './retry.js';
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
  await db().from('run_steps')
    .update({ status: 'pending', attempts: 0, last_error: null, updated_at: new Date().toISOString() })
    .eq('id', step.id);
  // Reset any existing job row, then ensure one is queued now.
  await db().from('jobs')
    .update({ status: 'queued', run_after: new Date().toISOString(), claimed_at: null })
    .eq('run_id', runId).eq('step_key', stepKey);
  await enqueueJobs(runId, [stepKey]);
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
